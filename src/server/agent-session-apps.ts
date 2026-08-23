import { db, schema } from '~/db';
import { AppError } from './errors';

/**
 * Record that a conversation entered an App editing flow. The relation is a
 * cumulative set: repeated lifecycle operations are intentionally idempotent.
 */
export function associateAgentSessionApp(
  sessionId: string,
  handle: string,
): Promise<{ appId: string }> {
  return db.transaction(async (tx) => {
    const session = await tx.query.agentSessions.findFirst({
      where: { id: sessionId },
      columns: { id: true },
    });
    if (!session) throw new AppError('Agent session not found.', 404);

    const byId = await tx.query.apps.findFirst({
      where: { id: handle },
      columns: { id: true },
    });
    const app =
      byId ??
      (await tx.query.apps.findFirst({
        where: { slug: handle },
        columns: { id: true },
      }));
    if (!app) throw new AppError(`App "${handle}" not found.`, 404);

    await tx
      .insert(schema.agentSessionApps)
      .values({ sessionId, appId: app.id })
      .onConflictDoNothing();
    return { appId: app.id };
  });
}
