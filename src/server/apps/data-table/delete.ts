/** Server-only: permanent deletion for a disabled managed Data Table. */
import { eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import { waitForDataMigrationBarrier } from './migrate';
import { dropAppDataDatabase, withAppDataCutoverLock } from './provision';
import { closeDataRealtime } from './realtime';

export const APP_DATA_DATABASE_NOT_PROVISIONED_ERROR =
  'Data Table database is not provisioned.';

/**
 * Delete a retained managed Data database after its capability is disabled.
 *
 * The App and Data cutover locks serialize this guard with deploy and rollback.
 * Capability gating prevents new Data requests while the realtime close and
 * migration barrier drain requests that passed their guard before disablement.
 * Registration is cleared only after both the database and role are gone.
 */
export async function deleteAppDataDatabase(
  id: string,
  expectedDbName: string,
): Promise<{ ok: true }> {
  // Dynamic import avoids loading the deploy/runtime graph from ordinary Data
  // Table request modules.
  const { appDeployLock } = await import('../deploy');
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, async () => {
      const app = await db.query.apps.findFirst({
        where: (row, { eq: equal }) => equal(row.id, id),
        columns: {
          status: true,
          capabilities: true,
          dataDbName: true,
          dataDbPasswordCiphertext: true,
          dataActivationId: true,
        },
      });
      if (!app) throw new Error(`App "${id}" not found.`);
      if (app.status === 'building') {
        throw new Error(
          'Cannot delete the Data Table database while a deployment is in progress.',
        );
      }
      if (app.capabilities?.dataTable) {
        throw new Error(
          'Disable capabilities.dataTable before deleting the Data Table database.',
        );
      }
      if (app.dataActivationId) {
        throw new Error(
          'Cannot delete the Data Table database while a deployment is being finalized.',
        );
      }
      if (!app.dataDbName) {
        throw new Error(APP_DATA_DATABASE_NOT_PROVISIONED_ERROR);
      }
      if (app.dataDbName !== expectedDbName) {
        throw new Error(
          'Data Table database name confirmation does not match.',
        );
      }

      await closeDataRealtime(id);
      // A failed first provisioning attempt can leave a reserved physical name
      // without a committed credential. No Data client can exist in that state,
      // so there is no migration/read transaction to drain before the forced
      // administrative drop.
      if (app.dataDbPasswordCiphertext) {
        await waitForDataMigrationBarrier(id);
      }
      await dropAppDataDatabase(id);
      await db
        .update(schema.apps)
        .set({
          dataDbName: null,
          dataDbPasswordCiphertext: null,
          dataSchemaHash: null,
          dataActivationId: null,
        })
        .where(eq(schema.apps.id, id));
      return { ok: true };
    }),
  );
}
