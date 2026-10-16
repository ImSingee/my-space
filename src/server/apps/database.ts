/** Server-only: registered App Database lifecycle and manual deletion. */
import { eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import { appDeployLock } from './deploy-lock';
import { withAppDataCutoverLock } from './data-table/provision';
import {
  APP_DATABASE_NOT_PROVISIONED_ERROR,
  withAppDatabaseLifecycle,
} from './provision';

/**
 * Permanently delete a retained App database after its capability is disabled.
 *
 * The App/Data cutover locks serialize this guard with deploy and rollback. The
 * database lifecycle lock then drains Agent queries before dropping the
 * database and role. Registration and encrypted credentials are cleared only
 * after both physical resources are gone, leaving a retry marker on failure.
 */
export async function deleteAppDatabase(
  id: string,
  expectedDbName: string,
  expectedAppName: string,
): Promise<{ ok: true }> {
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () =>
      withAppDatabaseLifecycle(id, async (database) => {
        const app = await db.query.apps.findFirst({
          where: { id },
          columns: {
            name: true,
            status: true,
            capabilities: true,
            dbName: true,
          },
        });
        if (!app) throw new Error(`App "${id}" not found.`);
        if (app.status === 'building') {
          throw new Error(
            'Cannot delete the app database while a deployment is in progress.',
          );
        }
        if (app.capabilities?.database) {
          throw new Error(
            'Disable capabilities.database before deleting the app database.',
          );
        }
        if (!app.dbName) {
          throw new Error(APP_DATABASE_NOT_PROVISIONED_ERROR);
        }
        if (app.dbName !== expectedDbName) {
          throw new Error('Database name confirmation does not match.');
        }

        if (app.name !== expectedAppName) {
          throw new Error('App name confirmation does not match.');
        }

        await database.drop();
        await db
          .update(schema.apps)
          .set({ dbName: null, dbPasswordCiphertext: null })
          .where(eq(schema.apps.id, id));
        return { ok: true };
      }),
    ),
  );
}
