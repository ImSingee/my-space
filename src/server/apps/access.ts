/** Server-only: authorize runtime serving of a deployed app's built assets. */
import { db } from '~/db';
import type { AppCapabilities } from '~/db/schema';
import type { NormalizedManifest } from './manifest';

/**
 * Resolve a path segment that may be either an app's immutable `id` (the stable
 * internal key) or its mutable `slug` (the human URL segment) to the canonical
 * id. Tries id first so legacy `/app/<id>/` links keep working unchanged, then
 * falls back to the slug. Returns null when neither matches.
 */
export async function resolveAppId(idOrSlug: string): Promise<string | null> {
  const byId = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, idOrSlug),
    columns: { id: true },
  });
  if (byId) return byId.id;
  const bySlug = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.slug, idOrSlug),
    columns: { id: true },
  });
  return bySlug?.id ?? null;
}

/** Look up an app's current (mutable) slug by its immutable id. */
export async function appSlug(id: string): Promise<string | null> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: { slug: true },
  });
  return app?.slug ?? null;
}

/**
 * True when `candidate` would collide with another app's id or slug. Because
 * `resolveAppId` matches an id before a slug, a slug equal to a *different*
 * app's id would silently shadow that app at `/app/<candidate>/`. Reserving ids
 * (not just slugs) during create/rename keeps resolution unambiguous.
 *
 * Pass `selfId` when renaming so an app can keep (or restore) a slug equal to
 * its own id without tripping the check.
 */
export async function slugConflictExists(
  candidate: string,
  selfId?: string,
): Promise<boolean> {
  const conflict = await db.query.apps.findFirst({
    where: (s, { or, eq, and, ne }) => {
      const sameValue = or(eq(s.slug, candidate), eq(s.id, candidate));
      return selfId ? and(sameValue, ne(s.id, selfId)) : sameValue;
    },
    columns: { id: true },
  });
  return Boolean(conflict);
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
