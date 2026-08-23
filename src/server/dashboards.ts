/** Server functions for dashboards and the widgets placed on them. */
import { createServerFn } from '@tanstack/react-start';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clampRefreshSeconds } from '~components/dashboard/refresh-presets';
import { db, schema, type TX } from '~/db';
import {
  DASHBOARD_BREAKPOINT_ORDER,
  deriveDashboardLayouts,
  type DashboardLayoutItem,
  type DashboardLayouts,
  type PersistedDashboardLayouts,
} from '~/lib/dashboard-layout';
import {
  dashboardWidgetIdsToRemove,
  dashboardWidgetKey,
} from '~/lib/dashboard-widget';
import { liveAppManifests } from './apps/access';
import { authMiddleware } from './auth';
import { persistSortOrder } from './sort-order';
import { idListSchema, idSchema, nameSchema } from './validation';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: appDeployLock=1 (apps/deploy.ts),
// workflowDeployLock=2 (workflows/deploy.ts), APP_KV_LOCK_NS=3
// (apps/kv.ts), SIDEBAR_PIN_LOCK_NS=4 (sidebar.ts).
const DASHBOARDS_LOCK_NS = 5;

async function lockDashboard(tx: TX, dashboardId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${DASHBOARDS_LOCK_NS}, hashtext(${dashboardId}))`,
  );
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
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
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
  appSlug: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  sortOrder: number;
  defaultSize: { w: number; h: number };
  /** Discrete footprints the widget supports; empty means free-form resizing. */
  supportedSizes: { w: number; h: number }[];
};

export type DashboardData = {
  /** Monotonic version of widget membership and all breakpoint layouts. */
  revision: number;
  widgets: DashboardItem[];
  layouts: DashboardLayouts;
};

export const getDashboard = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((dashboardId: string) => idSchema.parse(dashboardId))
  .handler(async ({ data: dashboardId }): Promise<DashboardData> => {
    // The lock makes failed-save reconciliation wait for any in-flight commit.
    // The joined statement then reads membership and layouts from one snapshot,
    // so a response can never combine opposite sides of the same transaction.
    const snapshot = await db.transaction(async (tx) => {
      await lockDashboard(tx, dashboardId);
      const rows = await tx
        .select({
          revision: schema.dashboards.editorRevision,
          id: schema.dashboardWidgets.id,
          appId: schema.dashboardWidgets.appId,
          widgetId: schema.dashboardWidgets.widgetId,
          sortOrder: schema.dashboardWidgets.sortOrder,
          breakpoint: schema.dashboardWidgetLayouts.breakpoint,
          x: schema.dashboardWidgetLayouts.x,
          y: schema.dashboardWidgetLayouts.y,
          w: schema.dashboardWidgetLayouts.w,
          h: schema.dashboardWidgetLayouts.h,
        })
        .from(schema.dashboards)
        .leftJoin(
          schema.dashboardWidgets,
          eq(schema.dashboardWidgets.dashboardId, schema.dashboards.id),
        )
        .leftJoin(
          schema.dashboardWidgetLayouts,
          eq(
            schema.dashboardWidgetLayouts.dashboardWidgetId,
            schema.dashboardWidgets.id,
          ),
        )
        .where(eq(schema.dashboards.id, dashboardId))
        .orderBy(
          asc(schema.dashboardWidgets.sortOrder),
          asc(schema.dashboardWidgets.createdAt),
          asc(schema.dashboardWidgetLayouts.breakpoint),
        );
      if (rows.length === 0) throw new Error('Dashboard not found.');
      return { revision: rows[0].revision, rows };
    });
    const placements: Array<{
      id: string;
      appId: string;
      widgetId: string;
      sortOrder: number;
    }> = [];
    const seenPlacements = new Set<string>();
    for (const row of snapshot.rows) {
      if (
        row.id === null ||
        row.appId === null ||
        row.widgetId === null ||
        row.sortOrder === null
      )
        continue;
      if (seenPlacements.has(row.id)) continue;
      seenPlacements.add(row.id);
      placements.push({
        id: row.id,
        appId: row.appId,
        widgetId: row.widgetId,
        sortOrder: row.sortOrder,
      });
    }
    // Resolve through the LIVE manifest (non-archived, widgets-capable) so a
    // placement for an archived/retired app is dropped rather than rendered as a
    // permanently failing card — the widget bundle route rejects those too.
    const appIds = [...new Set(placements.map((placement) => placement.appId))];
    const [manifests, apps] = await Promise.all([
      liveAppManifests(appIds, 'widgets'),
      appIds.length === 0
        ? Promise.resolve([])
        : db.query.apps.findMany({
            where: { id: { in: appIds } },
            columns: { id: true, slug: true },
          }),
    ]);
    const appSlugById = new Map(apps.map((app) => [app.id, app.slug]));
    const items: DashboardItem[] = [];
    for (const placement of placements) {
      const manifest = manifests.get(placement.appId);
      const appSlug = appSlugById.get(placement.appId);
      const widget = manifest?.widgets.find((w) => w.id === placement.widgetId);
      if (!manifest || !appSlug || !widget) continue;
      // Deployments made before widget supportedSizes existed have no such field
      // in their stored manifest; default to free-form ([]) for them.
      const supportedSizes = widget.supportedSizes ?? [];
      items.push({
        id: placement.id,
        appId: placement.appId,
        appSlug,
        appName: manifest.name,
        widgetId: widget.id,
        name: widget.name,
        url: widget.url,
        sortOrder: placement.sortOrder,
        defaultSize: widget.defaultSize,
        supportedSizes,
      });
    }

    const validIds = new Set(items.map((item) => item.id));
    const persisted: PersistedDashboardLayouts = {};
    for (const row of snapshot.rows) {
      if (
        row.id === null ||
        !validIds.has(row.id) ||
        row.breakpoint === null ||
        row.x === null ||
        row.y === null ||
        row.w === null ||
        row.h === null
      )
        continue;
      const layout = persisted[row.breakpoint] ?? [];
      layout.push({
        id: row.id,
        x: row.x,
        y: row.y,
        w: row.w,
        h: row.h,
      });
      persisted[row.breakpoint] = layout;
    }

    return {
      revision: snapshot.revision,
      widgets: items,
      layouts: deriveDashboardLayouts(items, persisted),
    };
  });

export type AvailableWidget = {
  appId: string;
  appSlug: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  defaultSize: { w: number; h: number };
  supportedSizes: { w: number; h: number }[];
};

export const listAvailableWidgets = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AvailableWidget[]> => {
    const deployed = await db.query.apps.findMany({
      where: { status: 'deployed' },
      columns: { id: true, slug: true },
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
          appSlug: app.slug,
          appName: manifest.name,
          widgetId: widget.id,
          name: widget.name,
          url: widget.url,
          defaultSize: widget.defaultSize,
          supportedSizes: widget.supportedSizes ?? [],
        });
      }
    }
    return items;
  });

export type DashboardDraftWidget = {
  /** Existing placement id or a client-only id for a newly added widget. */
  id: string;
  appId: string;
  widgetId: string;
};

export type DashboardDraftInput = {
  dashboardId: string;
  expectedRevision: number;
  /** Existing placements the user explicitly removed from the visible draft. */
  removedWidgetIds: string[];
  widgets: DashboardDraftWidget[];
  layouts: DashboardLayouts;
};

export type DashboardDraftSaveResult =
  | { status: 'saved'; data: DashboardData }
  | { status: 'conflict' };

const layoutItemSchema = z.object({
  id: idSchema,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const layoutSchema = z.array(layoutItemSchema).max(1000);

function assertCompleteLayouts(
  widgets: DashboardDraftWidget[],
  layouts: DashboardLayouts,
): void {
  const widgetIds = new Set(widgets.map((widget) => widget.id));
  for (const breakpoint of DASHBOARD_BREAKPOINT_ORDER) {
    const ids = layouts[breakpoint].map((item) => item.id);
    if (
      ids.length !== widgetIds.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !widgetIds.has(id))
    ) {
      throw new Error(
        `${breakpoint} layout must contain every dashboard widget exactly once.`,
      );
    }
  }
}

/**
 * Commit the complete editor draft as one transaction. Nothing in edit mode
 * writes before this call, so Cancel remains a purely local operation.
 */
export const saveDashboardDraft = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: DashboardDraftInput) =>
    z
      .object({
        dashboardId: idSchema,
        expectedRevision: z.number().int().nonnegative(),
        removedWidgetIds: idListSchema.refine(
          (ids) => new Set(ids).size === ids.length,
          'Dashboard draft contains duplicate removals.',
        ),
        widgets: z
          .array(
            z.object({
              id: idSchema,
              appId: idSchema,
              widgetId: idSchema,
            }),
          )
          .max(1000)
          .refine(
            (widgets) =>
              new Set(widgets.map((widget) => widget.id)).size ===
              widgets.length,
            'Dashboard draft contains duplicate client ids.',
          )
          .refine(
            (widgets) =>
              new Set(widgets.map(dashboardWidgetKey)).size === widgets.length,
            'Dashboard draft contains duplicate widgets.',
          ),
        layouts: z.object({
          desktop: layoutSchema,
          tablet: layoutSchema,
          mobile: layoutSchema,
        }),
      })
      .refine((draft) => {
        const retainedIds = new Set(draft.widgets.map((widget) => widget.id));
        return draft.removedWidgetIds.every((id) => !retainedIds.has(id));
      }, 'A dashboard widget cannot be retained and removed in the same draft.')
      .parse(input),
  )
  .handler(async ({ data }) => {
    return db.transaction(async (tx): Promise<DashboardDraftSaveResult> => {
      // Acquire the dashboard fence before any asynchronous preparation. A
      // reconciliation read taking the same lock cannot pass a save that is
      // still validating manifests, normalizing layouts, or committing rows.
      await lockDashboard(tx, data.dashboardId);

      const [dashboard] = await tx
        .select({
          id: schema.dashboards.id,
          editorRevision: schema.dashboards.editorRevision,
        })
        .from(schema.dashboards)
        .where(eq(schema.dashboards.id, data.dashboardId));
      if (!dashboard) throw new Error('Dashboard not found.');
      if (dashboard.editorRevision !== data.expectedRevision) {
        return { status: 'conflict' };
      }

      assertCompleteLayouts(data.widgets, data.layouts);

      const appIds = [...new Set(data.widgets.map((widget) => widget.appId))];
      const [manifests, apps] = await Promise.all([
        liveAppManifests(appIds, 'widgets', tx),
        appIds.length === 0
          ? Promise.resolve([])
          : tx.query.apps.findMany({
              where: { id: { in: appIds } },
              columns: { id: true, slug: true },
            }),
      ]);
      const appSlugById = new Map(apps.map((app) => [app.id, app.slug]));
      const widgetInfo = new Map<
        string,
        Omit<DashboardItem, 'id' | 'sortOrder'>
      >();
      for (const draftWidget of data.widgets) {
        const manifest = manifests.get(draftWidget.appId);
        const appSlug = appSlugById.get(draftWidget.appId);
        const widget = manifest?.widgets.find(
          (candidate) => candidate.id === draftWidget.widgetId,
        );
        if (!manifest || !appSlug || !widget) {
          throw new Error('A dashboard widget is no longer available.');
        }
        widgetInfo.set(draftWidget.id, {
          appId: draftWidget.appId,
          appSlug,
          appName: manifest.name,
          widgetId: draftWidget.widgetId,
          name: widget.name,
          url: widget.url,
          defaultSize: widget.defaultSize,
          supportedSizes: widget.supportedSizes ?? [],
        });
      }

      // Reuse the read-time normalization on untrusted input: clamp coordinates,
      // enforce declared widget footprints, and repair collisions deterministically.
      const normalizedLayouts = deriveDashboardLayouts(
        data.widgets.map((widget, sortOrder) => {
          const info = widgetInfo.get(widget.id);
          if (!info) throw new Error('Dashboard widget metadata is missing.');
          return {
            id: widget.id,
            sortOrder,
            defaultSize: info.defaultSize,
            supportedSizes: info.supportedSizes,
          };
        }),
        data.layouts,
      );

      const current = await tx
        .select({
          id: schema.dashboardWidgets.id,
          appId: schema.dashboardWidgets.appId,
          widgetId: schema.dashboardWidgets.widgetId,
        })
        .from(schema.dashboardWidgets)
        .where(eq(schema.dashboardWidgets.dashboardId, data.dashboardId));
      const currentById = new Map(current.map((row) => [row.id, row]));
      const currentByKey = new Map(
        current.map((row) => [dashboardWidgetKey(row), row]),
      );
      const clientToActual = new Map<string, string>();

      for (const [sortOrder, draftWidget] of data.widgets.entries()) {
        const existingById = currentById.get(draftWidget.id);
        if (
          existingById &&
          (existingById.appId !== draftWidget.appId ||
            existingById.widgetId !== draftWidget.widgetId)
        ) {
          throw new Error('Dashboard widget identity cannot be changed.');
        }

        let placement =
          existingById ?? currentByKey.get(dashboardWidgetKey(draftWidget));
        if (!placement) {
          [placement] = await tx
            .insert(schema.dashboardWidgets)
            .values({
              dashboardId: data.dashboardId,
              appId: draftWidget.appId,
              widgetId: draftWidget.widgetId,
              sortOrder,
            })
            .returning({
              id: schema.dashboardWidgets.id,
              appId: schema.dashboardWidgets.appId,
              widgetId: schema.dashboardWidgets.widgetId,
            });
        }
        if (!placement) throw new Error('Could not save dashboard widget.');
        clientToActual.set(draftWidget.id, placement.id);
      }

      // Missing rows are not removals: getDashboard intentionally hides
      // placements whose app/widget is temporarily unavailable. Delete only
      // placement ids that were visible and explicitly removed by the user.
      const retainedIds = [...clientToActual.values()];
      const removedWidgetIds = dashboardWidgetIdsToRemove(
        data.removedWidgetIds,
        retainedIds,
      );
      if (removedWidgetIds.length > 0) {
        await tx
          .delete(schema.dashboardWidgets)
          .where(
            and(
              eq(schema.dashboardWidgets.dashboardId, data.dashboardId),
              inArray(schema.dashboardWidgets.id, removedWidgetIds),
            ),
          );
      }

      if (retainedIds.length > 0) {
        await tx
          .delete(schema.dashboardWidgetLayouts)
          .where(
            inArray(
              schema.dashboardWidgetLayouts.dashboardWidgetId,
              retainedIds,
            ),
          );
      }

      const layoutRows = DASHBOARD_BREAKPOINT_ORDER.flatMap((breakpoint) =>
        normalizedLayouts[breakpoint].map((item) => ({
          dashboardWidgetId: clientToActual.get(item.id) as string,
          breakpoint,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        })),
      );
      if (layoutRows.length > 0) {
        await tx.insert(schema.dashboardWidgetLayouts).values(layoutRows);
      }

      for (const [sortOrder, item] of normalizedLayouts.desktop.entries()) {
        const id = clientToActual.get(item.id);
        if (!id) throw new Error('Dashboard widget id mapping is missing.');
        await tx
          .update(schema.dashboardWidgets)
          .set({ sortOrder })
          .where(eq(schema.dashboardWidgets.id, id));
      }

      const revision = dashboard.editorRevision + 1;
      await tx
        .update(schema.dashboards)
        .set({ editorRevision: revision, updatedAt: new Date() })
        .where(eq(schema.dashboards.id, data.dashboardId));

      const layouts = Object.fromEntries(
        DASHBOARD_BREAKPOINT_ORDER.map((breakpoint) => [
          breakpoint,
          normalizedLayouts[breakpoint].map(
            (item): DashboardLayoutItem => ({
              ...item,
              id: clientToActual.get(item.id) as string,
            }),
          ),
        ]),
      ) as DashboardLayouts;
      const desktopOrder = new Map(
        normalizedLayouts.desktop.map((item, index) => [item.id, index]),
      );
      const widgets = data.widgets
        .map((widget): DashboardItem => {
          const info = widgetInfo.get(widget.id);
          const id = clientToActual.get(widget.id);
          if (!info || !id)
            throw new Error('Saved dashboard data is incomplete.');
          return {
            id,
            ...info,
            sortOrder: desktopOrder.get(widget.id) ?? 0,
          };
        })
        .sort((left, right) => left.sortOrder - right.sortOrder);

      return {
        status: 'saved',
        data: { revision, widgets, layouts },
      };
    });
  });
