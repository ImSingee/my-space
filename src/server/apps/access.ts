/** Server-only: authorize runtime serving of a deployed app's built assets. */
import { db } from '~/db';
import type { AppCapabilities } from '~/db/schema';
import type { NormalizedManifest } from './manifest';

/**
 * Resolve an app that is currently allowed to serve runtime assets for the
 * given capability and return its live normalized manifest, or null when it
 * isn't servable.
 *
 * Returns null when the app doesn't exist, is archived, has never been deployed
 * (no `currentDeploymentId`), or lacks the requested capability — so retired or
 * never-built apps can't be reached through a stale direct URL and leftover
 * build/storage files. `building` (a redeploy of an already-live app) is
 * allowed because the previous build keeps serving until the swap.
 */
export async function liveAppManifest(
  id: string,
  capability: keyof AppCapabilities,
): Promise<NormalizedManifest | null> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.[capability]
  ) {
    return null;
  }
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
  });
  return (deployment?.manifestNormalized ?? null) as NormalizedManifest | null;
}
