/** Shared drag-reorder persistence for sortOrder-carrying tables. */
import { eq } from 'drizzle-orm';
import { db, schema } from '~/db';

type SortableTable = typeof schema.dashboards | typeof schema.sidebarItems;

/**
 * Persist a drag-reorder as one transaction: a mid-flight failure must not
 * leave half the rows on the new order and half on the old. Rows are updated
 * in id order so two concurrent reorders acquire row locks in the same
 * sequence (no deadlock); final values depend only on each row's target index,
 * so whichever transaction commits last wins wholesale.
 */
export async function persistSortOrder(
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
