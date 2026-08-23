/** Server-only: authorize runtime serving of a deployed app's built assets. */
import { db, type DB } from '~/db';
import type { AppCapabilities } from '~/db/schema';
import {
  isValidAppSlug,
  type NormalizedManifest,
  projectAppManifestUrls,
} from './manifest';

/**
 * Resolve an internal Agent handle that may be either an app's immutable `id`
 * or its mutable `slug` to the canonical id. Tries id first and returns null
 * when neither matches. Human-facing routes must use {@link appIdForSlug}.
 */
export async function resolveAppId(idOrSlug: string): Promise<string | null> {
  const byId = await db.query.apps.findFirst({
    where: { id: idOrSlug },
    columns: { id: true },
  });
  if (byId) return byId.id;
  const bySlug = await db.query.apps.findFirst({
    where: { slug: idOrSlug },
    columns: { id: true },
  });
  return bySlug?.id ?? null;
}

/** Resolve an app's current public slug to its immutable internal id. */
export async function appIdForSlug(slug: string): Promise<string | null> {
  if (!isValidAppSlug(slug)) return null;
  const app = await db.query.apps.findFirst({
    where: { slug },
    columns: { id: true },
  });
  return app?.id ?? null;
}

/** Look up an app's current (mutable) slug by its immutable id. */
export async function appSlug(id: string): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { slug: true },
  });
  return app?.slug ?? null;
}

/**
 * True when `candidate` would collide with another app's id or slug. Internal
 * Agent APIs use {@link resolveAppId}, which matches an id before a slug, so
 * reserving ids during create/rename keeps those handles unambiguous.
 *
 * Pass `selfId` when renaming so an app can keep (or restore) a slug equal to
 * its own id without tripping the check.
 */
export async function slugConflictExists(
  candidate: string,
  selfId?: string,
): Promise<boolean> {
  const conflict = await db.query.apps.findFirst({
    where: selfId
      ? {
          AND: [
            { OR: [{ slug: candidate }, { id: candidate }] },
            { id: { ne: selfId } },
          ],
        }
      : { OR: [{ slug: candidate }, { id: candidate }] },
    columns: { id: true },
  });
  return Boolean(conflict);
}

/**
 * The current deployment's normalized manifest regardless of app status —
 * unlike {@link liveAppManifest} this does NOT gate on archived/capability, so
 * the manage UI can still inspect an archived app. Null when the app doesn't
 * exist or has never deployed.
 */
export async function normalizedManifestFor(
  id: string,
): Promise<NormalizedManifest | null> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { slug: true, currentDeploymentId: true },
  });
  if (!app?.currentDeploymentId) return null;
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId as string },
    columns: { manifestNormalized: true },
  });
  const manifest = (deployment?.manifestNormalized ??
    null) as NormalizedManifest | null;
  return manifest ? projectAppManifestUrls(manifest, id, app.slug) : null;
}

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
  const result = await liveAppManifests([id], capability);
  return result.get(id) ?? null;
}

/** Single-app serving context including the deployment identity of its bytes. */
export async function liveAppDeployment(
  id: string,
  capability: keyof AppCapabilities,
): Promise<{
  deploymentId: string;
  manifest: NormalizedManifest;
} | null> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      slug: true,
      status: true,
      currentDeploymentId: true,
      capabilities: true,
    },
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
    where: { id: app.currentDeploymentId as string },
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return manifest
    ? {
        deploymentId: app.currentDeploymentId,
        manifest: projectAppManifestUrls(manifest, id, app.slug),
      }
    : null;
}

/**
 * Batch form of {@link liveAppManifest}: resolves many apps with two queries
 * instead of 2-per-app, for list endpoints (dashboard, sidebar). Apps that are
 * missing/archived/undeployed or lack the capability are simply absent from
 * the returned map.
 */
export async function liveAppManifests(
  ids: string[],
  capability: keyof AppCapabilities,
  database: Pick<DB, 'query'> = db,
): Promise<Map<string, NormalizedManifest>> {
  const result = new Map<string, NormalizedManifest>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return result;

  const apps = await database.query.apps.findMany({
    where: { id: { in: unique } },
  });
  const servable = apps.filter(
    (app) =>
      app.status !== 'archived' &&
      app.currentDeploymentId &&
      app.capabilities?.[capability],
  );
  if (servable.length === 0) return result;

  const deployments = await database.query.deployments.findMany({
    where: {
      id: {
        in: servable.map((app) => app.currentDeploymentId as string),
      },
    },
  });
  const byDeploymentId = new Map(deployments.map((d) => [d.id, d]));
  for (const app of servable) {
    const manifest = byDeploymentId.get(app.currentDeploymentId as string)
      ?.manifestNormalized as NormalizedManifest | null;
    if (manifest) {
      result.set(app.id, projectAppManifestUrls(manifest, app.id, app.slug));
    }
  }
  return result;
}
