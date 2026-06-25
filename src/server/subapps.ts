import { createServerFn } from '@tanstack/react-start';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { NormalizedManifest } from './subapps/manifest';

export const listSubapps = createServerFn({ method: 'GET' }).handler(
  async () => {
    // Opportunistically (re)start the cron scheduler on app load so schedules
    // survive a platform restart without requiring a redeploy.
    void import('./subapps/scheduler').then((m) => m.ensureScheduler());
    return db.query.subapps.findMany({
      orderBy: (s, { desc }) => [desc(s.updatedAt)],
    });
  },
);

export const getSubapp = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const row = await db.query.subapps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
    });
    return row ?? null;
  });

export type SubappRow = NonNullable<Awaited<ReturnType<typeof getSubapp>>>;

async function normalizedManifestFor(
  id: string,
): Promise<NormalizedManifest | null> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!subapp?.currentDeploymentId) return null;
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e }) => e(d.id, subapp.currentDeploymentId as string),
  });
  return (deployment?.manifestNormalized ?? null) as NormalizedManifest | null;
}

export const getNormalizedManifest = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => normalizedManifestFor(id));

export const deploySubappFn = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { deploySubapp } = await import('./subapps/deploy');
    const result = await deploySubapp(id);
    return {
      deploymentId: result.deploymentId,
      version: result.version,
      log: result.log,
    };
  });

export const listDeployments = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { listDeployments: list } = await import('./subapps/manage');
    return list(id);
  });

export const rollbackSubappFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; deploymentId: string }) => input)
  .handler(async ({ data }) => {
    const { rollbackSubapp } = await import('./subapps/manage');
    return rollbackSubapp(data.id, data.deploymentId);
  });

export const archiveSubappFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; archived: boolean }) => input)
  .handler(async ({ data }) => {
    const { setSubappArchived } = await import('./subapps/manage');
    return setSubappArchived(data.id, data.archived);
  });

export const deleteSubappFn = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const { deleteSubapp } = await import('./subapps/manage');
    return deleteSubapp(id);
  });

/** ================== capabilities (cron / webhook / storage / backend) ========= */

export type CronJobView = {
  name: string;
  schedule: string;
  path: string;
  nextRun: string | null;
};

export type StorageObjectView = {
  key: string;
  size: number;
  contentType: string;
  updatedAt: string;
};

export type SubappOps = {
  backend: {
    capable: boolean;
    mode: 'serverless' | 'long-running' | null;
    running: boolean;
  };
  cron: { enabled: boolean; jobs: CronJobView[] };
  webhook: { enabled: boolean; url: string | null; secret: string | null };
  storage: {
    enabled: boolean;
    url: string | null;
    objects: StorageObjectView[];
  };
};

export const getSubappOps = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }): Promise<SubappOps> => {
    const subapp = await db.query.subapps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
    });
    if (!subapp) {
      return {
        backend: { capable: false, mode: null, running: false },
        cron: { enabled: false, jobs: [] },
        webhook: { enabled: false, url: null, secret: null },
        storage: { enabled: false, url: null, objects: [] },
      };
    }
    const caps = subapp.capabilities;
    const manifest = await normalizedManifestFor(id);

    const { isSubappRunning } = await import('./subapps/runtime');
    const cronJobs = caps?.cron
      ? await import('./subapps/scheduler').then((m) => m.listCronJobs(id))
      : [];
    const objects =
      caps?.storage && subapp.status === 'deployed'
        ? await import('./subapps/storage').then((m) => m.listObjects(id))
        : [];

    return {
      backend: {
        capable: Boolean(caps?.backend),
        mode: subapp.backendMode ?? null,
        running: isSubappRunning(id),
      },
      cron: { enabled: Boolean(caps?.cron), jobs: cronJobs },
      webhook: {
        enabled: Boolean(caps?.webhook),
        url: manifest?.webhook?.url ?? null,
        secret: subapp.webhookSecret ?? null,
      },
      storage: {
        enabled: Boolean(caps?.storage),
        url: manifest?.storage?.url ?? null,
        objects,
      },
    };
  });

export const runCronJobFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; name: string }) => input)
  .handler(async ({ data }) => {
    const { runCronJobNow } = await import('./subapps/scheduler');
    return runCronJobNow(data.id, data.name);
  });

export const deleteStorageObjectFn = createServerFn({ method: 'POST' })
  .validator((input: { id: string; key: string }) => input)
  .handler(async ({ data }) => {
    const { deleteObject } = await import('./subapps/storage');
    const ok = await deleteObject(data.id, data.key);
    return { ok };
  });

/** ================== dashboard widgets ================== */

export type DashboardItem = {
  id: string;
  subappId: string;
  subappName: string;
  widgetId: string;
  name: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export const getDashboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardItem[]> => {
    const placements = await db.query.dashboardWidgets.findMany({
      orderBy: (w, { asc }) => [asc(w.sortOrder), asc(w.createdAt)],
    });
    const manifests = new Map<string, NormalizedManifest | null>();
    const items: DashboardItem[] = [];
    for (const placement of placements) {
      if (!manifests.has(placement.subappId)) {
        manifests.set(
          placement.subappId,
          await normalizedManifestFor(placement.subappId),
        );
      }
      const manifest = manifests.get(placement.subappId);
      const widget = manifest?.widgets.find((w) => w.id === placement.widgetId);
      if (!manifest || !widget) continue;
      items.push({
        id: placement.id,
        subappId: placement.subappId,
        subappName: manifest.name,
        widgetId: widget.id,
        name: widget.name,
        url: widget.url,
        x: placement.x,
        y: placement.y,
        w: placement.w,
        h: placement.h,
      });
    }
    return items;
  },
);

export type AvailableWidget = {
  subappId: string;
  subappName: string;
  widgetId: string;
  name: string;
  url: string;
  defaultSize: { w: number; h: number };
};

export const listAvailableWidgets = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AvailableWidget[]> => {
    const deployed = await db.query.subapps.findMany({
      where: (s, { eq: e }) => e(s.status, 'deployed'),
    });
    const items: AvailableWidget[] = [];
    for (const subapp of deployed) {
      const manifest = await normalizedManifestFor(subapp.id);
      if (!manifest) continue;
      for (const widget of manifest.widgets) {
        items.push({
          subappId: subapp.id,
          subappName: manifest.name,
          widgetId: widget.id,
          name: widget.name,
          url: widget.url,
          defaultSize: widget.defaultSize,
        });
      }
    }
    return items;
  },
);

export const addDashboardWidget = createServerFn({ method: 'POST' })
  .validator((input: { subappId: string; widgetId: string }) => input)
  .handler(async ({ data }) => {
    const manifest = await normalizedManifestFor(data.subappId);
    const widget = manifest?.widgets.find((w) => w.id === data.widgetId);
    if (!widget) {
      throw new Error('Widget not found in the deployed subapp.');
    }
    const existing = await db.query.dashboardWidgets.findFirst({
      where: (w, { eq: e }) =>
        and(e(w.subappId, data.subappId), e(w.widgetId, data.widgetId)),
    });
    if (existing) return existing;

    // Place the new widget in a tidy grid flow (12 cols) so multiple widgets
    // don't all pile up at (0,0) before the user arranges them.
    const all = await db.query.dashboardWidgets.findMany();
    const w = widget.defaultSize.w;
    const h = widget.defaultSize.h;
    const perRow = Math.max(1, Math.floor(12 / w));
    const index = all.length;
    const x = (index % perRow) * w;
    const y = Math.floor(index / perRow) * h;

    const [row] = await db
      .insert(schema.dashboardWidgets)
      .values({
        subappId: data.subappId,
        widgetId: data.widgetId,
        x,
        y,
        w,
        h,
        sortOrder: index,
      })
      .returning();
    return row;
  });

export const removeDashboardWidget = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    await db
      .delete(schema.dashboardWidgets)
      .where(eq(schema.dashboardWidgets.id, id));
    return { ok: true };
  });

/** ================== sidebar pins ================== */

export type SidebarItem = {
  id: string;
  subappId: string;
  label: string;
  status: schema.SubappStatus;
};

export const listSidebarItems = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SidebarItem[]> => {
    const pins = await db.query.sidebarItems.findMany({
      orderBy: (s, { asc }) => [asc(s.sortOrder), asc(s.createdAt)],
    });
    const items: SidebarItem[] = [];
    for (const pin of pins) {
      const subapp = await db.query.subapps.findFirst({
        where: (s, { eq: e }) => e(s.id, pin.subappId),
      });
      if (!subapp) continue;
      items.push({
        id: pin.id,
        subappId: pin.subappId,
        label: pin.label || subapp.name,
        status: subapp.status,
      });
    }
    return items;
  },
);

export const setSidebarPin = createServerFn({ method: 'POST' })
  .validator((input: { subappId: string; pinned: boolean }) => input)
  .handler(async ({ data }) => {
    const existing = await db.query.sidebarItems.findFirst({
      where: (s, { eq: e }) => e(s.subappId, data.subappId),
    });
    if (data.pinned) {
      if (existing) return existing;
      const subapp = await db.query.subapps.findFirst({
        where: (s, { eq: e }) => e(s.id, data.subappId),
      });
      if (!subapp) throw new Error('Subapp not found.');
      const count = await db.query.sidebarItems.findMany();
      const [row] = await db
        .insert(schema.sidebarItems)
        .values({
          subappId: data.subappId,
          label: subapp.name,
          sortOrder: count.length,
        })
        .returning();
      return row;
    }
    await db
      .delete(schema.sidebarItems)
      .where(eq(schema.sidebarItems.subappId, data.subappId));
    return { ok: true };
  });

type LayoutPatch = { id: string; x: number; y: number; w: number; h: number };

export const updateDashboardLayout = createServerFn({ method: 'POST' })
  .validator((items: LayoutPatch[]) => items)
  .handler(async ({ data: items }) => {
    await Promise.all(
      items.map((item, index) =>
        db
          .update(schema.dashboardWidgets)
          .set({
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            sortOrder: index,
          })
          .where(eq(schema.dashboardWidgets.id, item.id)),
      ),
    );
    return { ok: true };
  });
