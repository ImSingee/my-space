/** Server-only: read-only app inventory + details for Agent tools. */
import { db } from '~/db';
import type { AppCapabilities, AppStatus } from '~/db/schema';
import { listDeployments } from './manage';
import type { NormalizedManifest } from './manifest';

/** Capability flags in the same order the management UI lists them. */
const CAPABILITY_KEYS = [
  'frontend',
  'widgets',
  'backend',
  'database',
  'cron',
  'webhook',
  'storage',
  'workflow',
] as const satisfies readonly (keyof AppCapabilities)[];

function enabledCapabilities(
  caps: AppCapabilities | null | undefined,
): string[] {
  if (!caps) return [];
  return CAPABILITY_KEYS.filter((key) => caps[key]);
}

async function deploymentVersion(
  deploymentId: string | null,
): Promise<number | null> {
  if (!deploymentId) return null;
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, deploymentId),
  });
  return deployment?.version ?? null;
}

export type AppSummary = {
  id: string;
  name: string;
  description: string | null;
  status: AppStatus;
  /** Version of the live deployment, or null when never successfully deployed. */
  currentVersion: number | null;
  capabilities: string[];
  updatedAt: string;
};

/** All apps, newest-updated first, with a compact summary for discovery. */
export async function listAppsForAgent(): Promise<AppSummary[]> {
  const apps = await db.query.apps.findMany({
    orderBy: (s, { desc }) => [desc(s.updatedAt)],
  });
  return Promise.all(
    apps.map(async (app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      status: app.status,
      currentVersion: await deploymentVersion(app.currentDeploymentId),
      capabilities: enabledCapabilities(app.capabilities),
      updatedAt: app.updatedAt.toISOString(),
    })),
  );
}

export type AgentDeploymentSummary = {
  id: string;
  version: number;
  status: string;
  error: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
};

export type AppRuntimeOps = {
  backend: {
    capable: boolean;
    mode: 'serverless' | 'long-running' | null;
    running: boolean;
  };
  cron: {
    enabled: boolean;
    jobs: {
      name: string;
      schedule: string;
      path: string;
      nextRun: string | null;
    }[];
  };
  webhook: { enabled: boolean; url: string | null; hasSecret: boolean };
  storage: { enabled: boolean; url: string | null; objectCount: number };
};

export type AppDetail = {
  id: string;
  name: string;
  description: string | null;
  status: AppStatus;
  backendMode: 'serverless' | 'long-running' | null;
  dbName: string | null;
  currentVersion: number | null;
  currentDeploymentId: string | null;
  currentSourceCommit: string | null;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
  /** Normalized manifest of the live deployment (URLs, widgets, rpc, etc.). */
  manifest: NormalizedManifest | null;
  ops: AppRuntimeOps;
  /** Deployment history, newest first (build logs omitted to stay compact). */
  deployments: AgentDeploymentSummary[];
};

/**
 * Full detail for one app, mirroring the management panel: overview,
 * capabilities, normalized manifest, runtime ops, and deployment history.
 * Returns null when the app does not exist.
 */
export async function getAppDetailForAgent(
  id: string,
): Promise<AppDetail | null> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!app) return null;

  const currentDeployment = app.currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
      })
    : null;
  const manifest = (currentDeployment?.manifestNormalized ??
    null) as NormalizedManifest | null;

  const caps = app.capabilities;
  const { isAppRunning } = await import('./runtime');
  const cronJobs = caps?.cron
    ? await import('./scheduler').then((m) => m.listCronJobs(id))
    : [];
  const objects =
    caps?.storage && app.status === 'deployed'
      ? await import('./storage').then((m) => m.listObjects(id))
      : [];
  const deployments = await listDeployments(id);

  return {
    id: app.id,
    name: app.name,
    description: app.description,
    status: app.status,
    backendMode: app.backendMode ?? null,
    dbName: app.dbName ?? null,
    currentVersion: currentDeployment?.version ?? null,
    currentDeploymentId: app.currentDeploymentId ?? null,
    currentSourceCommit: app.currentSourceCommit ?? null,
    capabilities: enabledCapabilities(caps),
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
    manifest,
    ops: {
      backend: {
        capable: Boolean(caps?.backend),
        mode: app.backendMode ?? null,
        running: isAppRunning(id),
      },
      cron: { enabled: Boolean(caps?.cron), jobs: cronJobs },
      webhook: {
        enabled: Boolean(caps?.webhook),
        url: manifest?.webhook?.url ?? null,
        hasSecret: Boolean(app.webhookSecret),
      },
      storage: {
        enabled: Boolean(caps?.storage),
        url: manifest?.storage?.url ?? null,
        objectCount: objects.length,
      },
    },
    deployments: deployments.map((d) => ({
      id: d.id,
      version: d.version,
      status: d.status,
      error: d.error,
      createdAt: d.createdAt,
      isCurrent: d.isCurrent,
      canRollback: d.canRollback,
    })),
  };
}
