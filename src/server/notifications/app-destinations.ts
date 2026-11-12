/** Keep App destinations in step with what live deployments declare. */
import { eq } from 'drizzle-orm';
import { schema, type TX } from '~/db';
import type { NormalizedManifest } from '~server/apps/manifest';
import { newNotificationId } from './ingest';

/**
 * Called inside the deploy/rollback cutover transaction. Declaring
 * `notifications.destination` creates (or renames) the App's destination.
 * Dropping the declaration keeps the row so groups and routes survive a
 * redeploy; delivery checks the live manifest and fails with a clear reason.
 */
export async function syncAppNotificationDestination(
  tx: TX,
  appId: string,
  appName: string,
  manifest: NormalizedManifest | null | undefined,
): Promise<void> {
  const existing = await tx.query.notificationDestinations.findFirst({
    where: { appId },
    columns: { id: true, name: true },
  });
  if (existing) {
    if (existing.name !== appName) {
      await tx
        .update(schema.notificationDestinations)
        .set({ name: appName })
        .where(eq(schema.notificationDestinations.id, existing.id));
    }
    return;
  }
  if (!manifest?.notifications?.destination) return;
  await tx.insert(schema.notificationDestinations).values({
    id: newNotificationId(),
    type: 'app',
    name: appName,
    appId,
  });
}
