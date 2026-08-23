/**
 * Server-only: the Backends page's list/control operations.
 *
 * Lists every *runnable* app backend (deployed, not archived, declares the
 * backend capability) and exposes explicit start/stop/restart controls on
 * top of the runtime process manager. Runtime facts (started/stopped times,
 * exit codes) come from the in-memory runtime view and are never persisted.
 */
import { appCompatibility, type AppCompatibility } from '~/app-compatibility';
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
  compatibility: AppCompatibility | null;
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
    where: {
      status: { ne: 'archived' },
      currentDeploymentId: { isNotNull: true },
    },
    columns: {
      id: true,
      slug: true,
      name: true,
      capabilities: true,
      backendMode: true,
      currentDeploymentId: true,
    },
    orderBy: { name: 'asc', id: 'asc' },
  });
  const backendRows = rows.filter(
    (row) => row.capabilities?.backend && row.currentDeploymentId,
  );
  const deployments =
    backendRows.length === 0
      ? []
      : await db.query.deployments.findMany({
          where: {
            id: {
              in: backendRows.map((row) => row.currentDeploymentId as string),
            },
          },
          columns: { id: true, compatibilityVersion: true },
        });
  const compatibilityByDeployment = new Map(
    deployments.map((deployment) => [
      deployment.id,
      appCompatibility(deployment.compatibilityVersion),
    ]),
  );
  return backendRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    mode: r.backendMode ?? 'serverless',
    compatibility:
      compatibilityByDeployment.get(r.currentDeploymentId as string) ?? null,
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
  options: { requireSupportedCompatibility: boolean },
): Promise<{ id: string; mode: BackendMode; deploymentId: string }> {
  const app = await db.query.apps.findFirst({
    where: { id },
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
  if (options.requireSupportedCompatibility) {
    const { assertSupportedDeployment } = await import('./compatibility');
    await assertSupportedDeployment(app.currentDeploymentId);
  }
  return {
    id: app.id,
    mode: app.backendMode ?? 'serverless',
    deploymentId: app.currentDeploymentId,
  };
}

export async function startBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  const { mode, deploymentId } = await requireBackendApp(id, {
    requireSupportedCompatibility: true,
  });
  await startAppBackend(id, {
    keepAlive: mode === 'long-running',
    expectedDeploymentId: deploymentId,
  });
  return serializeRuntime(getBackendRuntimeView(id));
}

/** Idempotent: stopping a backend that isn't running succeeds. */
export async function stopBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  await requireBackendApp(id, { requireSupportedCompatibility: false });
  stopApp(id);
  return serializeRuntime(getBackendRuntimeView(id));
}

export async function restartBackendForApp(
  id: string,
): Promise<AppBackendRuntime> {
  const { mode, deploymentId } = await requireBackendApp(id, {
    requireSupportedCompatibility: true,
  });
  await restartAppBackend(id, {
    keepAlive: mode === 'long-running',
    expectedDeploymentId: deploymentId,
  });
  return serializeRuntime(getBackendRuntimeView(id));
}
