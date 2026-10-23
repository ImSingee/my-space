import { db, schema } from '~/db';

/** Shared instance pins retain their order, duplicate labels and deep links. */
export async function readWorkspace() {
  if (!(await db.query.dashboards.findFirst())) {
    await db
      .insert(schema.dashboards)
      .values({
        id: 'default',
        name: 'My Dashboard',
        pinned: true,
        sortOrder: 0,
      })
      .onConflictDoNothing();
  }
  const [dashboards, pins, apps, workflows] = await Promise.all([
    db.query.dashboards.findMany({
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
    }),
    db.query.sidebarItems.findMany({
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
    }),
    db.query.apps.findMany({ columns: { id: true, name: true, status: true } }),
    db.query.workflows.findMany({
      where: { pinned: true, status: { ne: 'archived' } },
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      columns: { id: true },
    }),
  ]);
  const byId = new Map(
    apps.filter((app) => app.status !== 'archived').map((app) => [app.id, app]),
  );
  return {
    dashboards: dashboards.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description ?? '',
      pinned: d.pinned,
      autoRefreshSeconds: d.autoRefresh,
    })),
    appPins: pins.flatMap((pin) => {
      const app = byId.get(pin.appId);
      return app
        ? [
            {
              id: pin.id,
              appId: pin.appId,
              label: pin.label || app.name,
              entryHash: pin.entryHash ?? '',
            },
          ]
        : [];
    }),
    pinnedWorkflowIds: workflows.map((w) => w.id),
  };
}
