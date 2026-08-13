import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { appIdForSlug, normalizedManifestFor, resolveAppId } =
  await import('./access');

beforeEach(async () => {
  await db.delete(schema.apps);
  await db.insert(schema.apps).values({
    id: '01immutableid',
    slug: 'human-readable-slug',
    name: 'Strict slug app',
  });
});

describe('appIdForSlug', () => {
  it('resolves the current slug to the immutable id', async () => {
    await expect(appIdForSlug('human-readable-slug')).resolves.toBe(
      '01immutableid',
    );
  });

  it('does not accept an immutable id that differs from the slug', async () => {
    await expect(appIdForSlug('01immutableid')).resolves.toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    await expect(appIdForSlug('missing')).resolves.toBeNull();
  });
});

describe('resolveAppId', () => {
  it('keeps accepting ids and slugs for internal Agent APIs', async () => {
    await expect(resolveAppId('01immutableid')).resolves.toBe('01immutableid');
    await expect(resolveAppId('human-readable-slug')).resolves.toBe(
      '01immutableid',
    );
  });
});

describe('normalizedManifestFor', () => {
  it('projects a renamed slug without rewriting the deployment', async () => {
    await db.insert(schema.deployments).values({
      id: '01deployment',
      appId: '01immutableid',
      status: 'deployed',
      manifestNormalized: {
        app: { url: '/api/apps/01immutableid/app/', routes: [] },
      },
    });
    await db
      .update(schema.apps)
      .set({ currentDeploymentId: '01deployment' })
      .where(eq(schema.apps.id, '01immutableid'));

    const manifest = await normalizedManifestFor('01immutableid');

    expect(manifest?.app?.url).toBe('/app/human-readable-slug/');
  });
});
