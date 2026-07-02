import { createServerFn } from '@tanstack/react-start';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clampRefreshSeconds } from '~components/dashboard/refresh-presets';
import { db, schema } from '~/db';
import type { NormalizedManifest, WebhookAuth } from './apps/manifest';
import { snapToSupportedSize } from './apps/manifest';
import { normalizeEntryHash } from './apps/sidebar';
import type { AppCronRunView } from './apps/scheduler';
import { authMiddleware } from './auth';

export type { AppCronRunView } from './apps/scheduler';

// Runtime validation for these HTTP-exposed RPCs: authMiddleware only gates
// *who* may call them, and the TS parameter types enforce nothing at runtime,
// so every payload is parsed before it reaches a handler.
const idSchema = z.string().min(1).max(200);
const idListSchema = z.array(idSchema).max(1000);
const nameSchema = z.string().max(500);
const keySchema = z.string().min(1).max(1024);
const idAndDeploymentSchema = z.object({
  id: idSchema,
  deploymentId: idSchema,
});
const idAndKeySchema = z.object({ id: idSchema, key: keySchema });

export type AppListItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: schema.AppStatus;
  capabilities: schema.AppCapabilities | null;
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
  status: schema.AppStatus;
  capabilities: schema.AppCapabilities | null;
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

async function normalizedManifestFor(
  id: string,
): Promise<NormalizedManifest | null> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!app?.currentDeploymentId) return null;
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e }) => e(d.id, app.currentDeploymentId as string),
  });
  return (deployment?.manifestNormalized ?? null) as NormalizedManifest | null;
}

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
    running: boolean;
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
        backend: { capable: false, mode: null, running: false },
        cron: { enabled: false, jobs: [] },
        webhook: { enabled: false, url: null, secret: null, auth: 'platform' },
        storage: { enabled: false, url: null, objects: [] },
        kv: { enabled: false },
      };
    }
    const caps = app.capabilities;
    const manifest = await normalizedManifestFor(id);

    const { isAppRunning } = await import('./apps/runtime');
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
        running: isAppRunning(id),
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

/** ================== dashboards ================== */

// Advisory-lock namespaces for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: APP_DEPLOY_LOCK_NS=1 (apps/deploy.ts),
// WORKFLOW_DEPLOY_LOCK_NS=2 (workflows/deploy.ts), APP_KV_LOCK_NS=3 (apps/kv.ts).
const SIDEBAR_PIN_LOCK_NS = 4;
const DASHBOARDS_LOCK_NS = 5;

type SortableTable = typeof schema.dashboards | typeof schema.sidebarItems;

/**
 * Persist a drag-reorder as one transaction: a mid-flight failure must not
 * leave half the rows on the new order and half on the old. Rows are updated
 * in id order so two concurrent reorders acquire row locks in the same
 * sequence (no deadlock); final values depend only on each row's target index,
 * so whichever transaction commits last wins wholesale.
 */
async function persistSortOrder(
  table: SortableTable,
  orderedIds: string[],
): Promise<void> {
  const targets = orderedIds
    .map((id, index) => ({ id, index }))
    .sort((a, b) => a.id.localeCompare(b.id));
  await db.transaction(async (tx) => {
    for (const { id, index } of targets) {
      await tx.update(table).set({ sortOrder: index }).where(eq(table.id, id));
    }
  });
}

export type Dashboard = {
  id: string;
  name: string;
  description: string | null;
  pinned: boolean;
  sortOrder: number;
  /** Auto-refresh interval in seconds; 0 disables auto-refresh. */
  autoRefreshSeconds: number;
};

/** Make sure at least one dashboard always exists for the UI to land on. */
async function ensureDefaultDashboard(): Promise<void> {
  const existing = await db.query.dashboards.findFirst();
  if (existing) return;
  await db
    .insert(schema.dashboards)
    .values({ id: 'default', name: 'My Dashboard', pinned: true, sortOrder: 0 })
    .onConflictDoNothing();
}

export const listDashboards = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<Dashboard[]> => {
    await ensureDefaultDashboard();
    const rows = await db.query.dashboards.findMany({
      orderBy: (d, { asc }) => [asc(d.sortOrder), asc(d.createdAt)],
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      pinned: d.pinned,
      sortOrder: d.sortOrder,
      autoRefreshSeconds: d.autoRefresh,
    }));
  });

export const createDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { name: string }) =>
    z.object({ name: nameSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<Dashboard> => {
    const name = data.name.trim() || 'Untitled';
    const [row] = await db
      .insert(schema.dashboards)
      .values({
        name,
        pinned: true,
        // Append at the end via max+1, not a row count: counts shrink after
        // deletions and would hand out an order a surviving row already uses.
        sortOrder: sql`(select coalesce(max(${schema.dashboards.sortOrder}), -1) + 1 from ${schema.dashboards})`,
      })
      .returning();
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      pinned: row.pinned,
      sortOrder: row.sortOrder,
      autoRefreshSeconds: row.autoRefresh,
    };
  });

export const setDashboardPin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; pinned: boolean }) =>
    z.object({ id: idSchema, pinned: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    await db
      .update(schema.dashboards)
      .set({ pinned: data.pinned })
      .where(eq(schema.dashboards.id, data.id));
    return { ok: true };
  });

export const renameDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; name: string }) =>
    z.object({ id: idSchema, name: nameSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const name = data.name.trim();
    if (!name) throw new Error('Dashboard name cannot be empty.');
    await db
      .update(schema.dashboards)
      .set({ name })
      .where(eq(schema.dashboards.id, data.id));
    return { ok: true };
  });

export const setDashboardDescription = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; description: string }) =>
    z.object({ id: idSchema, description: z.string().max(4000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const description = data.description.trim();
    await db
      .update(schema.dashboards)
      .set({ description: description || null })
      .where(eq(schema.dashboards.id, data.id));
    return { ok: true };
  });

export const setDashboardAutoRefresh = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; seconds: number }) =>
    z.object({ id: idSchema, seconds: z.number() }).parse(input),
  )
  .handler(async ({ data }) => {
    // The UI offers a fixed preset list but we never trust the client to send a
    // sane value, so clamp to a non-negative whole number of seconds (0 = off).
    const seconds = clampRefreshSeconds(data.seconds);
    await db
      .update(schema.dashboards)
      .set({ autoRefresh: seconds })
      .where(eq(schema.dashboards.id, data.id));
    return { ok: true };
  });

export const deleteDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    // Count and delete under one lock: two concurrent deletes could otherwise
    // both see count=2, both pass the check, and leave zero dashboards.
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${DASHBOARDS_LOCK_NS}, 0)`,
      );
      const count = await tx.$count(schema.dashboards);
      if (count <= 1) {
        throw new Error('You must keep at least one dashboard.');
      }
      await tx.delete(schema.dashboards).where(eq(schema.dashboards.id, id));
      return { ok: true };
    });
  });

export const reorderDashboards = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((orderedIds: string[]) => idListSchema.parse(orderedIds))
  .handler(async ({ data: orderedIds }) => {
    await persistSortOrder(schema.dashboards, orderedIds);
    return { ok: true };
  });

/** ================== dashboard widgets ================== */

export type DashboardItem = {
  id: string;
  appId: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Discrete footprints the widget supports; empty means free-form resizing. */
  supportedSizes: { w: number; h: number }[];
};

export const getDashboard = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((dashboardId: string) => idSchema.parse(dashboardId))
  .handler(async ({ data: dashboardId }): Promise<DashboardItem[]> => {
    const placements = await db.query.dashboardWidgets.findMany({
      where: (w, { eq: e }) => e(w.dashboardId, dashboardId),
      orderBy: (w, { asc }) => [asc(w.sortOrder), asc(w.createdAt)],
    });
    // Resolve through the LIVE manifest (non-archived, widgets-capable) so a
    // placement for an archived/retired app is dropped rather than rendered as a
    // permanently failing card — the widget bundle route rejects those too.
    const { liveAppManifest } = await import('./apps/access');
    const manifests = new Map<string, NormalizedManifest | null>();
    const items: DashboardItem[] = [];
    for (const placement of placements) {
      if (!manifests.has(placement.appId)) {
        manifests.set(
          placement.appId,
          await liveAppManifest(placement.appId, 'widgets'),
        );
      }
      const manifest = manifests.get(placement.appId);
      const widget = manifest?.widgets.find((w) => w.id === placement.widgetId);
      if (!manifest || !widget) continue;
      // Deployments made before widget supportedSizes existed have no such field
      // in their stored manifest; default to free-form ([]) for them.
      const supportedSizes = widget.supportedSizes ?? [];
      // A placement saved while the widget was free-form (or before it declared
      // sizes) can hold a footprint the widget no longer supports. Snap it on
      // read so the widget opens at a supported size and RGL compacts using it;
      // the snapped value is persisted later on the next user drag/resize (we
      // don't auto-write on load — edits persist only on explicit user action).
      const size =
        supportedSizes.length > 0
          ? (snapToSupportedSize(supportedSizes, {
              w: placement.w,
              h: placement.h,
            }) ?? { w: placement.w, h: placement.h })
          : { w: placement.w, h: placement.h };
      items.push({
        id: placement.id,
        appId: placement.appId,
        appName: manifest.name,
        widgetId: widget.id,
        name: widget.name,
        url: widget.url,
        x: placement.x,
        y: placement.y,
        w: size.w,
        h: size.h,
        supportedSizes,
      });
    }
    return items;
  });

export type AvailableWidget = {
  appId: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  defaultSize: { w: number; h: number };
};

export const listAvailableWidgets = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AvailableWidget[]> => {
    const deployed = await db.query.apps.findMany({
      where: (s, { eq: e }) => e(s.status, 'deployed'),
    });
    const items: AvailableWidget[] = [];
    for (const app of deployed) {
      const manifest = await normalizedManifestFor(app.id);
      if (!manifest) continue;
      for (const widget of manifest.widgets) {
        items.push({
          appId: app.id,
          appName: manifest.name,
          widgetId: widget.id,
          name: widget.name,
          url: widget.url,
          defaultSize: widget.defaultSize,
        });
      }
    }
    return items;
  });

export const addDashboardWidget = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    (input: { dashboardId: string; appId: string; widgetId: string }) =>
      z
        .object({ dashboardId: idSchema, appId: idSchema, widgetId: idSchema })
        .parse(input),
  )
  .handler(async ({ data }) => {
    const manifest = await normalizedManifestFor(data.appId);
    const widget = manifest?.widgets.find((w) => w.id === data.widgetId);
    if (!widget) {
      throw new Error('Widget not found in the deployed app.');
    }
    const existing = await db.query.dashboardWidgets.findFirst({
      where: (w, { eq: e }) =>
        and(
          e(w.dashboardId, data.dashboardId),
          e(w.appId, data.appId),
          e(w.widgetId, data.widgetId),
        ),
    });
    if (existing) return existing;

    // Place the new widget in a tidy grid flow (12 cols) so multiple widgets
    // don't all pile up at (0,0) before the user arranges them. The flow index
    // is only a placement heuristic — react-grid-layout resolves any overlap on
    // render — but sortOrder must not collide, so it's assigned max+1 in SQL.
    const all = await db.query.dashboardWidgets.findMany({
      where: (w, { eq: e }) => e(w.dashboardId, data.dashboardId),
    });
    const w = widget.defaultSize.w;
    const h = widget.defaultSize.h;
    const perRow = Math.max(1, Math.floor(12 / w));
    const index = all.length;
    const x = (index % perRow) * w;
    const y = Math.floor(index / perRow) * h;

    const [row] = await db
      .insert(schema.dashboardWidgets)
      .values({
        dashboardId: data.dashboardId,
        appId: data.appId,
        widgetId: data.widgetId,
        x,
        y,
        w,
        h,
        sortOrder: sql`(select coalesce(max(${schema.dashboardWidgets.sortOrder}), -1) + 1 from ${schema.dashboardWidgets} where ${schema.dashboardWidgets.dashboardId} = ${data.dashboardId})`,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // Lost a concurrent add race: return the placement the winner created.
    return db.query.dashboardWidgets.findFirst({
      where: (col, { eq: e }) =>
        and(
          e(col.dashboardId, data.dashboardId),
          e(col.appId, data.appId),
          e(col.widgetId, data.widgetId),
        ),
    });
  });

export const removeDashboardWidget = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    await db
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.id, id));
    return { ok: true };
  });

/** ================== sidebar pins ================== */

export type SidebarItem = {
  id: string;
  appId: string;
  label: string;
  /** Hash entry point within the app (no leading '#'); null opens the root. */
  entryHash: string | null;
  status: schema.AppStatus;
};

export const listSidebarItems = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<SidebarItem[]> => {
    const pins = await db.query.sidebarItems.findMany({
      orderBy: (s, { asc }) => [asc(s.sortOrder), asc(s.createdAt)],
    });
    const items: SidebarItem[] = [];
    for (const pin of pins) {
      const app = await db.query.apps.findFirst({
        where: (s, { eq: e }) => e(s.id, pin.appId),
      });
      if (!app) continue;
      items.push({
        id: pin.id,
        appId: pin.appId,
        label: pin.label || app.name,
        entryHash: pin.entryHash ?? null,
        status: app.status,
      });
    }
    return items;
  });

/** Next sidebar sortOrder: max+1, so deletions never cause collisions. */
const nextSidebarSortOrder = sql`(select coalesce(max(${schema.sidebarItems.sortOrder}), -1) + 1 from ${schema.sidebarItems})`;

async function appendSidebarPin(appId: string) {
  // One global sidebar-insert lock (not per-app): it serializes this insert
  // against setSidebarPin AND makes the max+1 sortOrder allocation safe across
  // concurrent pins of *different* apps. Pin writes are rare; contention is nil.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SIDEBAR_PIN_LOCK_NS}, 0)`,
    );
    const app = await tx.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, appId),
    });
    if (!app) throw new Error('App not found.');
    const [row] = await tx
      .insert(schema.sidebarItems)
      .values({ appId, label: app.name, sortOrder: nextSidebarSortOrder })
      .returning();
    return row;
  });
}

/**
 * App-level pin toggle used by the app page: `pinned: true` ensures the app has
 * at least one sidebar pin, `pinned: false` removes every pin for the app.
 */
export const setSidebarPin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { appId: string; pinned: boolean }) =>
    z.object({ appId: idSchema, pinned: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    if (data.pinned) {
      // The app_id index is no longer unique (apps can be pinned many times via
      // addSidebarItem), so guard this "ensure one pin" toggle against
      // concurrent calls with the global sidebar-insert advisory lock —
      // otherwise two racing requests could both pass the existence check and
      // create duplicates. The lock is global (not per-app) so the max+1
      // sortOrder allocation is also collision-free across different apps.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SIDEBAR_PIN_LOCK_NS}, 0)`,
        );
        const existing = await tx.query.sidebarItems.findFirst({
          where: (s, { eq: e }) => e(s.appId, data.appId),
        });
        if (existing) return existing;
        const app = await tx.query.apps.findFirst({
          where: (s, { eq: e }) => e(s.id, data.appId),
        });
        if (!app) throw new Error('App not found.');
        const [row] = await tx
          .insert(schema.sidebarItems)
          .values({
            appId: data.appId,
            label: app.name,
            sortOrder: nextSidebarSortOrder,
          })
          .returning();
        return row;
      });
    }
    await db
      .delete(schema.sidebarItems)
      .where(eq(schema.sidebarItems.appId, data.appId));
    return { ok: true };
  });

/** Always create an additional sidebar pin (apps may be pinned many times). */
export const addSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { appId: string }) =>
    z.object({ appId: idSchema }).parse(input),
  )
  .handler(async ({ data }) => appendSidebarPin(data.appId));

/** Remove a single sidebar pin by its id (leaves the app's other pins). */
export const removeSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => z.object({ id: idSchema }).parse(input))
  .handler(async ({ data }) => {
    await db
      .delete(schema.sidebarItems)
      .where(eq(schema.sidebarItems.id, data.id));
    return { ok: true };
  });

export const updateSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; label: string; entryHash?: string }) =>
    z
      .object({
        id: idSchema,
        label: nameSchema,
        // normalizeEntryHash caps the stored length; this only bounds the input.
        entryHash: z.string().max(2048).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const label = data.label.trim();
    if (!label) throw new Error('Name cannot be empty.');
    // Normalize the entry point to the bare hash fragment we store (or null for
    // the app root). Only update it when the caller actually sent the field.
    const entryHash =
      data.entryHash === undefined
        ? undefined
        : normalizeEntryHash(data.entryHash);
    await db
      .update(schema.sidebarItems)
      .set(entryHash === undefined ? { label } : { label, entryHash })
      .where(eq(schema.sidebarItems.id, data.id));
    return { ok: true };
  });

export const reorderSidebarItems = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((orderedIds: string[]) => idListSchema.parse(orderedIds))
  .handler(async ({ data: orderedIds }) => {
    await persistSortOrder(schema.sidebarItems, orderedIds);
    return { ok: true };
  });

type LayoutPatch = { id: string; x: number; y: number; w: number; h: number };

/** react-grid-layout column count (mirrors COLS in dashboard-grid.tsx). */
const DASHBOARD_GRID_COLS = 12;
const DASHBOARD_MAX_H = 100;
const DASHBOARD_MAX_Y = 10_000;

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export const updateDashboardLayout = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((items: LayoutPatch[]) =>
    z
      .array(
        z.object({
          id: idSchema,
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
        }),
      )
      .max(1000)
      .parse(items),
  )
  .handler(async ({ data: items }) => {
    // Clamp before writing: never persist client-supplied coords verbatim — a
    // crafted call could otherwise store negative or out-of-grid values that
    // break later react-grid-layout renders.
    const patches = items.map((item, index) => {
      const w = clampInt(item.w, 1, DASHBOARD_GRID_COLS, 1);
      return {
        id: item.id,
        w,
        x: clampInt(item.x, 0, DASHBOARD_GRID_COLS - w, 0),
        y: clampInt(item.y, 0, DASHBOARD_MAX_Y, 0),
        h: clampInt(item.h, 1, DASHBOARD_MAX_H, 1),
        sortOrder: index,
      };
    });
    // One transaction, rows updated in id order: a mid-flight failure can't
    // strand half the grid on the old layout, and two concurrent saves take
    // row locks in the same sequence instead of deadlocking.
    await db.transaction(async (tx) => {
      const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
      for (const { id, ...patch } of ordered) {
        await tx
          .update(schema.dashboardWidgets)
          .set(patch)
          .where(eq(schema.dashboardWidgets.id, id));
      }
    });
    return { ok: true };
  });
