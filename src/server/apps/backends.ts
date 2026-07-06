/**
 * Server-only: the Backends page's list/control operations.
 *
 * Lists every *runnable* app backend (deployed, not archived, declares the
 * backend capability) and exposes explicit start/stop/restart controls on
 * top of the runtime process manager. Runtime facts (started/stopped times,
 * exit codes) come from the in-memory runtime view and are never persisted.
 */
import { db } from '~/db';
import { AppError } from '../errors';
import {
  type BackendRuntimeView,
  getBackendRuntimeView,
  restartAppBackend,
  startAppBackend,
  stopApp,
} from './runtime';

type BackendMode = 'serverless' | 'long-running';

/** Wire-format runtime view: epoch-ms timestamps become ISO strings. */
export type AppBackendRuntime = {
  state: BackendRuntimeView['state'];
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  restartCount: number;
  keepAlive: boolean;
};

export type AppBackendView = {
  id: string;
  slug: string;
  name: string;
  mode: BackendMode;
  runtime: AppBackendRuntime;
};

function serializeRuntime(view: BackendRuntimeView): AppBackendRuntime {
  return {
    ...view,
    startedAt:
      view.startedAt == null ? null : new Date(view.startedAt).toISOString(),
    stoppedAt:
      view.stoppedAt == null ? null : new Date(view.stoppedAt).toISOString(),
  };
}

/** Every app whose backend can be run from the Backends page. */
export async function listAppBackends(): Promise<AppBackendView[]> {
  const rows = await db.query.apps.findMany({
    where: (s, { and, isNotNull, ne }) =>
      and(ne(s.status, 'archived'), isNotNull(s.currentDeploymentId)),
    columns: {
      id: true,
      slug: true,
      name: true,
      capabilities: true,
      backendMode: true,
    },
    orderBy: (s, { asc }) => [asc(s.name), asc(s.id)],
  });
  return rows
    .filter((r) => r.capabilities?.backend)
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      mode: r.backendMode ?? 'serverless',
      runtime: serializeRuntime(getBackendRuntimeView(r.id)),
    }));
}

/**
 * Guard for the backend control server fns. These are plain authenticated
 * RPCs, so the page only listing runnable backends is not a boundary — a
 * crafted call could otherwise boot an archived or never-deployed app's
 * stale build. Re-check the target here before touching the runtime.
 */
async function requireBackendApp(
  id: string,
): Promise<{ id: string; mode: BackendMode }> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: {
      id: true,
      status: true,
      capabilities: true,
      backendMode: true,
      currentDeploymentId: true,
    },
  });
  if (!app || app.status === 'archived') {
    throw new AppError('App not found.', 404);
  }
  if (!app.capabilities?.backend) {
    throw new AppError('This app has no backend.', 400);
  }
  if (!app.currentDeploymentId) {
    throw new AppError('This app has never been deployed.', 400);
  }
  return { id: app.id, mode: app.backendMode ?? 'serverless' };
}

export async function startBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  const { mode } = await requireBackendApp(id);
  await startAppBackend(id, { keepAlive: mode === 'long-running' });
  return serializeRuntime(getBackendRuntimeView(id));
}

/** Idempotent: stopping a backend that isn't running succeeds. */
export async function stopBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  await requireBackendApp(id);
  stopApp(id);
  return serializeRuntime(getBackendRuntimeView(id));
}

export async function restartBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  const { mode } = await requireBackendApp(id);
  await restartAppBackend(id, { keepAlive: mode === 'long-running' });
  return serializeRuntime(getBackendRuntimeView(id));
}
