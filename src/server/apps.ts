/** Server functions for app management (list/detail, deployments, ops, KV). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { db } from '~/db';
// Type-only: a value import of `schema` used in exported type annotations
// would survive the client transform and drag postgres-js into the browser
// bundle (crashing hydration with "Buffer is not defined").
import type { AppCapabilities, AppStatus } from '~/db/schema';
import { normalizedManifestFor } from './apps/access';
import type {
  NormalizedManifest,
  UserscriptRunAt,
  WebhookAuth,
} from './apps/manifest';
import type { AppCronRunView } from './apps/scheduler';
import { authMiddleware } from './auth';
import {
  idAndDeploymentSchema,
  idAndKeySchema,
  idSchema,
  nameSchema,
} from './validation';

export type { AppCronRunView } from './apps/scheduler';
export type { AppBackendRuntime, AppBackendView } from './apps/backends';

export type AppListItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppStatus;
  capabilities: AppCapabilities | null;
  createdAt: string;
  updatedAt: string;
};

export const listApps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AppListItem[]> => {
    // Opportunistically (re)start the cron scheduler on app load so schedules
    // survive a platform restart without requiring a redeploy.
    void import('./apps/scheduler').then((m) => m.ensureScheduler());
    // Project to a safe view model: the raw row carries secrets/internal columns
    // (webhookSecret, dbName, repoPath, source commit, raw manifest) the app
    // list UI never needs and must not ship to the browser.
    const rows = await db.query.apps.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
      columns: {
        id: true,
        slug: true,
        name: true,
        description: true,
        status: true,
        capabilities: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

export type AppDetail = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppStatus;
  capabilities: AppCapabilities | null;
  currentSourceCommit: string | null;
  dbName: string | null;
  createdAt: string;
  updatedAt: string;
};

export const getApp = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: idOrSlug }): Promise<AppDetail | null> => {
    // Project to a display view: the raw row carries secrets/internal columns
    // (webhookSecret, repoPath, raw manifest, currentDeploymentId) the app
    // detail/manage pages never need and must not ship to the browser.
    //
    // Accept either the immutable id or the mutable slug (id first) so the
    // /apps/<x> management routes work even when a link carries the slug (e.g.
    // an agent deploy_app call made with a slug handle).
    const columns = {
      id: true,
      slug: true,
      name: true,
      description: true,
      status: true,
      capabilities: true,
      currentSourceCommit: true,
      dbName: true,
      createdAt: true,
      updatedAt: true,
    } as const;
    const row =
      (await db.query.apps.findFirst({
        where: (s, { eq: e }) => e(s.id, idOrSlug),
        columns,
      })) ??
      (await db.query.apps.findFirst({
        where: (s, { eq: e }) => e(s.slug, idOrSlug),
        columns,
      }));
    if (!row) return null;
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

export type AppRow = NonNullable<Awaited<ReturnType<typeof getApp>>>;

export const getNormalizedManifest = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => normalizedManifestFor(id));

export const listDeployments = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const { listDeployments: list } = await import('./apps/manage');
    return list(id);
  });

export const getDeploymentBuildLog = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) =>
    idAndDeploymentSchema.parse(input),
  )
  .handler(async ({ data }) => {
    const { deploymentBuildLog } = await import('./apps/manage');
    return deploymentBuildLog(data.id, data.deploymentId);
  });

export const rollbackAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) =>
    idAndDeploymentSchema.parse(input),
  )
  .handler(async ({ data }) => {
    const { rollbackApp } = await import('./apps/manage');
    return rollbackApp(data.id, data.deploymentId);
  });

export const archiveAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; archived: boolean }) =>
    z.object({ id: idSchema, archived: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { setAppArchived } = await import('./apps/manage');
    return setAppArchived(data.id, data.archived);
  });

export const deleteAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const { deleteApp } = await import('./apps/manage');
    return deleteApp(id);
  });

export const setAppSlugFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; slug: string }) =>
    z.object({ id: idSchema, slug: z.string().max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { renameAppSlug } = await import('./apps/manage');
    return renameAppSlug(data.id, data.slug);
  });

/** ================== capabilities (cron / webhook / storage / backend) ========= */

export type CronJobView = {
  name: string;
  schedule: string;
  method: string | null;
  path: string | null;
  nextRun: string | null;
};

export type StorageObjectView = {
  key: string;
  size: number;
  contentType: string;
  updatedAt: string;
};

export type AppKvEntryView = {
  key: string;
  /** Plaintext value, or null when secret (hidden from the UI; overwrite-only). */
  value: string | null;
  secret: boolean;
  updatedAt: string;
};

export type AppOps = {
  backend: {
    capable: boolean;
    mode: 'serverless' | 'long-running' | null;
  };
  cron: { enabled: boolean; jobs: CronJobView[] };
  webhook: {
    enabled: boolean;
    url: string | null;
    /** Present only in 'platform' auth mode (the verified shared secret). */
    secret: string | null;
    /** Platform-side auth mode: 'platform' (secret + HMAC) or 'none'. */
    auth: WebhookAuth;
  };
  storage: {
    enabled: boolean;
    url: string | null;
    objects: StorageObjectView[];
  };
  /** KV entries are fetched separately (they mutate live); this just gates the UI. */
  kv: { enabled: boolean };
};

export const getAppOps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppOps> => {
    const app = await db.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
    });
    if (!app) {
      return {
        backend: { capable: false, mode: null },
        cron: { enabled: false, jobs: [] },
        webhook: { enabled: false, url: null, secret: null, auth: 'platform' },
        storage: { enabled: false, url: null, objects: [] },
        kv: { enabled: false },
      };
    }
    const caps = app.capabilities;
    const manifest: NormalizedManifest | null = await normalizedManifestFor(id);

    const cronJobs = caps?.cron
      ? await import('./apps/scheduler').then((m) => m.listCronJobs(id))
      : [];
    const objects =
      caps?.storage && app.status === 'deployed'
        ? await import('./apps/storage').then((m) => m.listObjects(id))
        : [];

    return {
      backend: {
        capable: Boolean(caps?.backend),
        mode: app.backendMode ?? null,
      },
      cron: { enabled: Boolean(caps?.cron), jobs: cronJobs },
      webhook: {
        enabled: Boolean(caps?.webhook),
        url: manifest?.webhook?.url ?? null,
        // Only surface the secret in platform-auth mode. A secret may still be
        // persisted on the row (kept for rollback safety) while the live mode is
        // 'none', but it is meaningless there, so don't leak it to the browser.
        secret:
          (manifest?.webhook?.auth ?? 'platform') === 'platform'
            ? (app.webhookSecret ?? null)
            : null,
        auth: manifest?.webhook?.auth ?? 'platform',
      },
      storage: {
        enabled: Boolean(caps?.storage),
        url: manifest?.storage?.url ?? null,
        objects,
      },
      kv: { enabled: Boolean(caps?.kv) },
    };
  });

/** ================== backends page (list + start/stop/restart) ========= */

export const listAppBackendsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    const { listAppBackends } = await import('./apps/backends');
    return listAppBackends();
  });

export const startAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const { startBackendForApp } = await import('./apps/backends');
    return startBackendForApp(id);
  });

export const stopAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const { stopBackendForApp } = await import('./apps/backends');
    return stopBackendForApp(id);
  });

export const restartAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const { restartBackendForApp } = await import('./apps/backends');
    return restartBackendForApp(id);
  });

export const runCronJobFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; name: string }) =>
    z.object({ id: idSchema, name: nameSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { runCronJobNow } = await import('./apps/scheduler');
    return runCronJobNow(data.id, data.name);
  });

export const listCronRunsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppCronRunView[]> => {
    const { listCronRuns } = await import('./apps/scheduler');
    return listCronRuns(id);
  });

export const deleteStorageObjectFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; key: string }) =>
    // Storage keys have no write-side length cap (the storage route accepts
    // whatever safeKey normalizes), so this must accept anything the API could
    // have stored — the bound only exceeds PATH_MAX so no on-disk key is ever
    // rejected here. Path safety itself is enforced by safeKey/resolvePaths.
    z.object({ id: idSchema, key: z.string().min(1).max(8192) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { deleteObject } = await import('./apps/storage');
    const ok = await deleteObject(data.id, data.key);
    return { ok };
  });

/** ================== app KV (manage UI) ================== */

/**
 * Guard for the KV management server fns. These are plain authenticated RPCs, so
 * the UI only rendering the KV panel for kv-capable apps is not a real boundary —
 * a crafted call could otherwise read/write `app_kv` for an arbitrary id. Re-check
 * here that the target app exists, isn't archived, and actually has the `kv`
 * capability before touching the table. (Single-tenant: a valid session is the
 * owner, so this is existence/capability gating, not cross-user authorization.)
 */
async function requireKvApp(id: string): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
    columns: { status: true, capabilities: true },
  });
  if (!app || app.status === 'archived' || !app.capabilities?.kv) {
    throw new Error('App not found');
  }
}

export const listAppKvFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppKvEntryView[]> => {
    await requireKvApp(id);
    const { listKv } = await import('./apps/kv');
    const records = await listKv(id);
    // Mask secret values: the manage UI may overwrite them but never read them.
    return records.map((r) => ({
      key: r.key,
      value: r.secret ? null : r.value,
      secret: r.secret,
      updatedAt: r.updatedAt,
    }));
  });

export const setAppKvFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    (input: { id: string; key: string; value: string; secret?: boolean }) =>
      // Key/value length limits live in the KV module (KvError with proper
      // messages); this only guards shape and types.
      z
        .object({
          id: idSchema,
          key: z.string(),
          value: z.string(),
          secret: z.boolean().optional(),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    await requireKvApp(data.id);
    const { setKv } = await import('./apps/kv');
    const rec = await setKv(data.id, data.key, data.value, {
      secret: data.secret,
    });
    return { ok: true, secret: rec.secret };
  });

export const deleteAppKvFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; key: string }) =>
    idAndKeySchema.parse(input),
  )
  .handler(async ({ data }) => {
    await requireKvApp(data.id);
    const { deleteKv } = await import('./apps/kv');
    return { ok: await deleteKv(data.id, data.key) };
  });

/** ================== userscripts (manage UI) ================== */

/** One installable Tampermonkey script for the manage page's Browser scripts panel. */
export type UserscriptInstallLink = {
  id: string;
  name: string;
  matches: string[];
  grants: string[];
  connects: string[];
  runAt: UserscriptRunAt | null;
  noframes: boolean;
  description: string | null;
  /**
   * Tokenized `.user.js` download path (relative). The manage UI prepends
   * `window.location.origin` for the copy/install action. Carries the app-level
   * secret, so it's only ever returned to an authenticated manage request.
   */
  url: string;
};

export const listUserscriptInstallLinksFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<UserscriptInstallLink[]> => {
    const app = await db.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: {
        status: true,
        capabilities: true,
        currentDeploymentId: true,
        userscriptSecret: true,
      },
    });
    // Only a live, non-archived, userscripts-capable app with a minted token has
    // installable links. Anything else yields an empty list so the panel hides.
    if (
      !app ||
      app.status === 'archived' ||
      !app.currentDeploymentId ||
      !app.capabilities?.userscripts ||
      !app.userscriptSecret
    ) {
      return [];
    }
    const manifest = await normalizedManifestFor(id);
    const scripts = manifest?.userscripts ?? [];
    const token = encodeURIComponent(app.userscriptSecret);
    return scripts.map((s) => ({
      id: s.id,
      name: s.name,
      matches: s.matches,
      grants: s.grants,
      connects: s.connects,
      runAt: s.runAt ?? null,
      noframes: s.noframes,
      description: s.description ?? null,
      url: `${s.url}?token=${token}`,
    }));
  });
