import { db } from '~/db';
import { appCompatibility } from '~/app-compatibility';
import { isValidAppSlug } from './apps/manifest';
import { AppError } from './errors';

/** Preserve the published App RPC's availability and navigation contract. */
export async function resolveLegacyAppHandoffPath(
  id: string,
): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      slug: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  if (!app) return null;
  const deployment = app.currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: app.currentDeploymentId, appId: id },
        columns: { compatibilityVersion: true },
      })
    : null;
  if (
    !deployment ||
    !app.capabilities?.frontend ||
    app.status === 'archived' ||
    !appCompatibility(deployment.compatibilityVersion).isSupported ||
    !isValidAppSlug(app.slug)
  ) {
    throw new AppError('App is not available to open', 409);
  }
  return `/app/${app.slug}/embed/`;
}
