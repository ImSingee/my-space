/** Server-only: read-only app inventory + details for Agent tools. */
import { inArray } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AppCapabilities, AppStatus } from '~/db/schema';
import { listDeployments } from './manage';
import type { NormalizedManifest, WebhookAuth } from './manifest';

/** Capability flags in the same order the management UI lists them. */
const CAPABILITY_KEYS = [
  'frontend',
  'widgets',
  'backend',
  'database',
  'cron',
  'webhook',
  'kv',
  'userscripts',
] as const satisfies readonly (keyof AppCapabilities)[];

function enabledCapabilities(
  caps: AppCapabilities | null | undefined,
): string[] {
  if (!caps) return [];
  return CAPABILITY_KEYS.filter((key) => caps[key]);
}

export type AppSummary = {
  id: string;
  slug: string;
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
  const deploymentIds = apps
    .map((app) => app.currentDeploymentId)
    .filter((id): id is string => Boolean(id));
  const deployments =
    deploymentIds.length === 0
      ? []
      : await db.query.deployments.findMany({
          where: inArray(schema.deployments.id, deploymentIds),
          columns: { id: true, version: true },
        });
  const versionByDeploymentId = new Map(
    deployments.map((d) => [d.id, d.version]),
  );
  return apps.map((app) => ({
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    status: app.status,
    currentVersion: app.currentDeploymentId
      ? (versionByDeploymentId.get(app.currentDeploymentId) ?? null)
      : null,
    capabilities: enabledCapabilities(app.capabilities),
    updatedAt: app.updatedAt.toISOString(),
  }));
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
      method: string | null;
      path: string | null;
      nextRun: string | null;
    }[];
  };
  webhook: {
    enabled: boolean;
    url: string | null;
    hasSecret: boolean;
    /** Platform-side auth mode: 'platform' (secret + HMAC) or 'none'. */
    auth: WebhookAuth;
  };
  kv: { enabled: boolean; url: string | null; entryCount: number };
};

export type AppDetail = {
  id: string;
  slug: string;
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
  const kvCount = caps?.kv
    ? await import('./kv').then((m) => m.countKv(id))
    : 0;
  const deployments = await listDeployments(id);

  return {
    id: app.id,
    slug: app.slug,
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
        // A secret may persist on the row for rollback safety while the live
        // mode is 'none'; only report it when the live mode actually uses it.
        hasSecret:
          (manifest?.webhook?.auth ?? 'platform') === 'platform' &&
          Boolean(app.webhookSecret),
        auth: manifest?.webhook?.auth ?? 'platform',
      },
      kv: {
        enabled: Boolean(caps?.kv),
        url: manifest?.kv?.url ?? null,
        entryCount: kvCount,
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
