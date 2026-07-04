/** Server functions for sidebar app pins. */
import { createServerFn } from '@tanstack/react-start';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import { normalizeEntryHash } from './apps/sidebar';
import { authMiddleware } from './auth';
import { persistSortOrder } from './sort-order';
import { idListSchema, idSchema, nameSchema } from './validation';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: appDeployLock=1 (apps/deploy.ts),
// workflowDeployLock=2 (workflows/deploy.ts), APP_KV_LOCK_NS=3
// (apps/kv.ts), DASHBOARDS_LOCK_NS=5 (dashboards.ts).
const SIDEBAR_PIN_LOCK_NS = 4;

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
    if (pins.length === 0) return [];
    const apps = await db.query.apps.findMany({
      where: inArray(schema.apps.id, [...new Set(pins.map((p) => p.appId))]),
      columns: { id: true, name: true, status: true },
    });
    const appById = new Map(apps.map((app) => [app.id, app]));
    const items: SidebarItem[] = [];
    for (const pin of pins) {
      const app = appById.get(pin.appId);
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
