/** Server-only Workflow identity lookups. */
import { db } from '~/db';
import { isValidWorkflowSlug } from './manifest';

/** Resolve a Workflow's current public slug to its immutable internal id. */
export async function workflowIdForSlug(slug: string): Promise<string | null> {
  if (!isValidWorkflowSlug(slug)) return null;
  const workflow = await db.query.workflows.findFirst({
    where: { slug },
    columns: { id: true },
  });
  return workflow?.id ?? null;
}

/** Look up a Workflow's current mutable slug by its immutable id. */
export async function workflowSlug(id: string): Promise<string | null> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
    columns: { slug: true },
  });
  return workflow?.slug ?? null;
}

/** Check only the human-facing Workflow slug namespace. */
export async function workflowSlugExists(
  candidate: string,
  selfId?: string,
): Promise<boolean> {
  const conflict = await db.query.workflows.findFirst({
    where: selfId
      ? { AND: [{ slug: candidate }, { id: { ne: selfId } }] }
      : { slug: candidate },
    columns: { id: true },
  });
  return Boolean(conflict);
}
