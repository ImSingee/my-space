import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { APP_SLUG_MAX_LENGTH } from '~/app-identity';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  appIdForSlug,
  liveAppDeployment,
  liveAppManifests,
  normalizedManifestFor,
  resolveAppId,
} = await import('./access');

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

  it('rejects a slug above the 64-character boundary', async () => {
    await expect(
      appIdForSlug(`a${'b'.repeat(APP_SLUG_MAX_LENGTH)}`),
    ).resolves.toBeNull();
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
        widgets: [
          {
            id: 'summary',
            url: '/api/apps/01immutableid/widget/summary',
          },
        ],
        kv: { url: '/api/apps/01immutableid/kv' },
      },
    });
    await db
      .update(schema.apps)
      .set({ currentDeploymentId: '01deployment' })
      .where(eq(schema.apps.id, '01immutableid'));

    const manifest = await normalizedManifestFor('01immutableid');

    expect(manifest?.app?.url).toBe('/app/human-readable-slug/embed/');
    expect(manifest?.widgets[0]?.url).toBe(
      '/api/app/01immutableid/widget/summary',
    );
    expect(manifest?.kv?.url).toBe('/api/app/01immutableid/kv');
    const stored = await db.query.deployments.findFirst({
      where: eq(schema.deployments.id, '01deployment'),
    });
    expect(stored?.manifestNormalized).toMatchObject({
      app: { url: '/api/apps/01immutableid/app/' },
      kv: { url: '/api/apps/01immutableid/kv' },
    });
  });

  it('projects URLs for single and batched live serving lookups', async () => {
    await db.insert(schema.deployments).values({
      id: '01deployment',
      appId: '01immutableid',
      status: 'deployed',
      manifestNormalized: {
        widgets: [
          {
            id: 'summary',
            url: '/api/apps/01immutableid/widget/summary',
          },
        ],
      },
    });
    await db
      .update(schema.apps)
      .set({
        status: 'deployed',
        currentDeploymentId: '01deployment',
        capabilities: {
          database: false,
          frontend: false,
          widgets: true,
          backend: false,
          cron: false,
          webhook: false,
          kv: false,
        },
      })
      .where(eq(schema.apps.id, '01immutableid'));

    const single = await liveAppDeployment('01immutableid', 'widgets');
    const batch = await liveAppManifests(['01immutableid'], 'widgets');

    expect(single?.manifest.widgets[0]?.url).toBe(
      '/api/app/01immutableid/widget/summary',
    );
    expect(batch.get('01immutableid')?.widgets[0]?.url).toBe(
      '/api/app/01immutableid/widget/summary',
    );
  });
});
