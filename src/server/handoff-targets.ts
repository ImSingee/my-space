import { z } from 'zod';
import { db } from '~/db';
import { appCompatibility } from '~/app-compatibility';
import { isValidAppSlug } from './apps/manifest';
import { AppError } from './errors';

/** Closed resource identities shared by issuance and consumption. */
export const handoffTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('app'), id: z.string().min(1).max(191) }),
  z.strictObject({
    type: z.literal('dashboard'),
    id: z
      .string()
      .min(1)
      .max(191)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
]);
export type HandoffTarget = z.infer<typeof handoffTargetSchema>;

async function appPath(id: string): Promise<string | null> {
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

/** Re-read domain availability; never accept a path supplied by the caller. */
export async function resolveHandoffTarget(
  target: HandoffTarget,
): Promise<string | null> {
  switch (target.type) {
    case 'app':
      return appPath(target.id);
    case 'dashboard': {
      const dashboard = await db.query.dashboards.findFirst({
        where: { id: target.id },
        columns: { id: true },
      });
      return dashboard
        ? `/dashboard/${encodeURIComponent(dashboard.id)}`
        : null;
    }
  }
}
