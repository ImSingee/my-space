import { db, schema } from '~/db';
import {
  DEFAULT_HOMEPAGE,
  homepageTargetSchema,
  type HomepageTarget,
} from '~/homepage';
import { normalizeEntryHash } from './apps/sidebar';
import { liveAppManifest, liveAppManifests } from './apps/access';

export async function listHomepageApps(): Promise<
  { id: string; name: string }[]
> {
  const apps = await db.query.apps.findMany({
    columns: { id: true, name: true },
    orderBy: { name: 'asc', id: 'asc' },
  });
  const live = await liveAppManifests(
    apps.map((app) => app.id),
    'frontend',
  );
  return apps.filter((app) => Boolean(live.get(app.id)?.app));
}

export async function readHomepage(userId: string): Promise<HomepageTarget> {
  const row = await db.query.userPreferences.findFirst({ where: { userId } });
  const parsed = homepageTargetSchema.safeParse(row?.homepage);
  return parsed.success ? parsed.data : DEFAULT_HOMEPAGE;
}

/** Resolve stored identities against current resources, never reused slugs. */
export async function homepageDestination(
  homepage: HomepageTarget,
): Promise<{ href: string; available: boolean }> {
  if (homepage.kind === 'page') {
    return { href: `/${homepage.page}`, available: true };
  }
  if (homepage.kind === 'dashboard') {
    const dashboard = await db.query.dashboards.findFirst({
      where: { id: homepage.dashboardId },
      columns: { id: true },
    });
    if (dashboard) {
      return {
        href: `/dashboard/${encodeURIComponent(dashboard.id)}`,
        available: true,
      };
    }
  } else {
    const app = await db.query.apps.findFirst({
      where: { id: homepage.appId },
      columns: { slug: true },
    });
    if (app && (await liveAppManifest(homepage.appId, 'frontend'))?.app) {
      const url = new URL(
        `/app/${encodeURIComponent(app.slug)}`,
        'https://hatch.invalid',
      );
      url.hash = normalizeEntryHash(homepage.entryHash ?? '') ?? '';
      return { href: `${url.pathname}${url.hash}`, available: true };
    }
  }
  return { href: '/dashboard', available: false };
}

export async function saveHomepage(
  userId: string,
  input: HomepageTarget,
): Promise<HomepageTarget> {
  const parsed = homepageTargetSchema.parse(input);
  const homepage: HomepageTarget =
    parsed.kind === 'app'
      ? { ...parsed, entryHash: normalizeEntryHash(parsed.entryHash ?? '') }
      : parsed;
  const { available } = await homepageDestination(homepage);
  if (!available)
    throw new Error(
      'This homepage is no longer available. Choose another page.',
    );
  await db
    .insert(schema.userPreferences)
    .values({ userId, homepage })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { homepage, updatedAt: new Date() },
    });
  return homepage;
}
