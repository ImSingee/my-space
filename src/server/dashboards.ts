/** Server functions for dashboards and the widgets placed on them. */
import { createServerFn } from '@tanstack/react-start';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clampRefreshSeconds } from '~components/dashboard/refresh-presets';
import { db, schema } from '~/db';
import { liveAppManifests, normalizedManifestFor } from './apps/access';
import { snapToSupportedSize } from './apps/manifest';
import { authMiddleware } from './auth';
import { persistSortOrder } from './sort-order';
import { idListSchema, idSchema, nameSchema } from './validation';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: APP_DEPLOY_LOCK_NS=1 (apps/deploy.ts),
// WORKFLOW_DEPLOY_LOCK_NS=2 (workflows/deploy.ts), APP_KV_LOCK_NS=3
// (apps/kv.ts), SIDEBAR_PIN_LOCK_NS=4 (sidebar.ts).
const DASHBOARDS_LOCK_NS = 5;

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
    const manifests = await liveAppManifests(
      placements.map((p) => p.appId),
      'widgets',
    );
    const items: DashboardItem[] = [];
    for (const placement of placements) {
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
      columns: { id: true },
    });
    const manifests = await liveAppManifests(
      deployed.map((app) => app.id),
      'widgets',
    );
    const items: AvailableWidget[] = [];
    for (const app of deployed) {
      const manifest = manifests.get(app.id);
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

/** ================== widget layout ================== */

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
