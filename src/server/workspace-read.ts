import { db, schema } from '~/db';

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

export async function readDashboards(): Promise<Dashboard[]> {
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
}

export type SidebarItem = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  /** Hash entry point within the app (no leading '#'); null opens the root. */
  entryHash: string | null;
  status: schema.AppStatus;
};

export async function readSidebarItems(): Promise<SidebarItem[]> {
  const pins = await db.query.sidebarItems.findMany({
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  if (pins.length === 0) return [];
  const apps = await db.query.apps.findMany({
    where: { id: { in: [...new Set(pins.map((p) => p.appId))] } },
    columns: { id: true, slug: true, name: true, status: true },
  });
  const appById = new Map(apps.map((app) => [app.id, app]));
  const items: SidebarItem[] = [];
  for (const pin of pins) {
    const app = appById.get(pin.appId);
    if (!app) continue;
    items.push({
      id: pin.id,
      appId: pin.appId,
      appSlug: app.slug,
      label: pin.label || app.name,
      entryHash: pin.entryHash ?? null,
      status: app.status,
    });
  }
  return items;
}

/** Shared navigation projections, called only behind a user-session boundary. */
export async function readWorkspace() {
  const [dashboards, pins, workflows] = await Promise.all([
    readDashboards(),
    readSidebarItems(),
    db.query.workflows.findMany({
      where: { pinned: true, status: { ne: 'archived' } },
      // Match listWorkflows and the web sidebar, not the unused sortOrder.
      orderBy: { updatedAt: 'desc' },
      columns: { id: true },
    }),
  ]);
  return {
    dashboards: dashboards.map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description ?? '',
      pinned: dashboard.pinned,
      autoRefreshSeconds: dashboard.autoRefreshSeconds,
    })),
    appPins: pins
      .filter((pin) => pin.status !== 'archived')
      .map((pin) => ({
        id: pin.id,
        appId: pin.appId,
        appSlug: pin.appSlug,
        label: pin.label,
        entryHash: pin.entryHash ?? '',
      })),
    pinnedWorkflowIds: workflows.map((workflow) => workflow.id),
  };
}
