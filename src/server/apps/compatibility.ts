/** Server-only helpers for enforcing the App runtime compatibility boundary. */
import {
  APP_COMPATIBILITY_UPDATE_MESSAGE,
  appCompatibility,
  type AppCompatibility,
} from '~/app-compatibility';
import { db, type DB } from '~/db';
import { AppError } from '~server/errors';

export async function readDeploymentCompatibility(
  deploymentId: string,
  database: Pick<DB, 'query'> = db,
): Promise<AppCompatibility | null> {
  const deployment = await database.query.deployments.findFirst({
    where: { id: deploymentId },
    columns: { compatibilityVersion: true },
  });
  return deployment ? appCompatibility(deployment.compatibilityVersion) : null;
}

export async function assertSupportedDeployment(
  deploymentId: string,
): Promise<AppCompatibility> {
  const compatibility = await readDeploymentCompatibility(deploymentId);
  if (!compatibility) {
    throw new AppError('The active App deployment record is unavailable.', 503);
  }
  if (!compatibility.isSupported) {
    throw new AppError(APP_COMPATIBILITY_UPDATE_MESSAGE, 503);
  }
  return compatibility;
}
