import { eq } from 'drizzle-orm';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOMEPAGE_PAGES, type HomepageTarget } from '~/homepage';

const fixture = vi.hoisted(() => ({
  userId: 'owner-a' as string | null,
  close: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  const database = await createTestDb();
  fixture.close = () => database.db.$client.close();
  return database;
});
vi.mock('~auth/server', () => ({
  auth: {
    api: {
      getSession: async () =>
        fixture.userId
          ? {
              user: { id: fixture.userId },
              session: { token: 'never-return-this-session-token' },
            }
          : null,
    },
  },
}));
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://hatch.test/'),
}));
// Execute the production handlers, validators and auth middleware against the
// real migrations; the transport is exercised separately on the real Platform.
vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    const middleware: ((context: {
      next: () => Promise<void>;
    }) => Promise<unknown>)[] = [];
    let validate: ((data: unknown) => unknown) | undefined;
    const builder = {
      middleware: (handlers: typeof middleware) => {
        middleware.push(...handlers);
        return builder;
      },
      validator: (validator: typeof validate) => {
        validate = validator;
        return builder;
      },
      handler:
        (handler: (context: { data: unknown }) => unknown) =>
        async (input?: { data?: unknown }) => {
          for (const handler of middleware)
            await handler({ next: async () => {} });
          return handler({
            data: validate ? validate(input?.data) : input?.data,
          });
        },
    };
    return builder;
  },
}));

const { db, schema } = await import('~/db');
const { getHomepageSettings, updateHomepageSettings, getHomepageDestination } =
  await import('./homepage');
const capabilities = {
  database: false,
  frontend: true,
  widgets: false,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
};

beforeEach(async () => {
  fixture.userId = 'owner-a';
  await db.delete(schema.user);
  await db.delete(schema.apps);
  await db.delete(schema.dashboards);
  await db.insert(schema.user).values(
    ['owner-a', 'owner-b'].map((id) => ({
      id,
      name: id,
      email: `${id}@homepage.test`,
    })),
  );
  await db.insert(schema.apps).values({
    id: 'app-one',
    slug: 'first-slug',
    name: 'App',
    status: 'deployed',
    capabilities,
  });
  await db.insert(schema.deployments).values({
    id: 'deployment-one',
    appId: 'app-one',
    status: 'deployed',
    compatibilityVersion: 2,
    manifestNormalized: { app: { url: '/app/first-slug', routes: [] } },
  });
  await db
    .update(schema.apps)
    .set({ currentDeploymentId: 'deployment-one' })
    .where(eq(schema.apps.id, 'app-one'));
  await db
    .insert(schema.dashboards)
    .values({ id: 'dashboard-one', name: 'Dashboard' });
});
afterAll(async () => fixture.close?.());

describe('personal homepage contract', () => {
  it('upgrades an existing platform without rewriting accounts or backfilling preferences', async () => {
    const legacy = new PGlite();
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: path.resolve(import.meta.dirname, '../../migrations'),
      });
      const index = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('CREATE TABLE "user_preferences"'),
        ),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      for (const migration of migrations.slice(0, index)) {
        for (const statement of migration.sql) await legacy.exec(statement);
      }
      await legacy.exec(
        `INSERT INTO "user" (id, name, email) VALUES ('legacy', 'Legacy account', 'legacy@homepage.test')`,
      );
      for (const statement of migrations[index]!.sql)
        await legacy.exec(statement);
      expect(
        (await legacy.query('SELECT id, name, email FROM "user"')).rows,
      ).toEqual([
        { id: 'legacy', name: 'Legacy account', email: 'legacy@homepage.test' },
      ]);
      expect(
        (await legacy.query('SELECT * FROM user_preferences')).rows,
      ).toEqual([]);
    } finally {
      await legacy.close();
    }
  });
  it('defaults existing/new accounts and corrupt stored preferences to the Dashboard', async () => {
    expect(await getHomepageDestination()).toBe('/dashboard');
    expect(await getHomepageSettings()).toEqual({
      userId: 'owner-a',
      homepage: { kind: 'page', page: 'dashboard' },
      available: true,
      apps: [{ id: 'app-one', name: 'App' }],
    });
    await db.insert(schema.userPreferences).values({
      userId: 'owner-a',
      homepage: {
        kind: 'url',
        href: 'https://outside.test',
      } as unknown as HomepageTarget,
    });
    expect(await getHomepageDestination()).toBe('/dashboard');
  });

  it('isolates authenticated accounts, persists upserts, and cascades account deletion', async () => {
    await updateHomepageSettings({ data: { kind: 'page', page: 'agent' } });
    fixture.userId = 'owner-b';
    expect(await getHomepageDestination()).toBe('/dashboard');
    await updateHomepageSettings({ data: { kind: 'page', page: 'apps' } });
    fixture.userId = 'owner-a';
    expect(await getHomepageDestination()).toBe('/agent');
    await updateHomepageSettings({ data: { kind: 'page', page: 'workflows' } });
    expect(await getHomepageDestination()).toBe('/workflows');
    expect(await db.select().from(schema.userPreferences)).toHaveLength(2);
    const settings = await getHomepageSettings();
    expect(JSON.stringify(settings)).not.toContain('session-token');
    await db.delete(schema.user).where(eq(schema.user.id, 'owner-a'));
    expect(
      (await db.select().from(schema.userPreferences)).map((row) => row.userId),
    ).toEqual(['owner-b']);
  });

  it('rejects unauthenticated reads/writes, foreign identities, URLs and unavailable resources without changing the saved preference', async () => {
    fixture.userId = null;
    await expect(getHomepageSettings()).rejects.toThrow('Unauthorized');
    await expect(getHomepageDestination()).rejects.toThrow('Unauthorized');
    await expect(
      updateHomepageSettings({ data: { kind: 'page', page: 'agent' } }),
    ).rejects.toThrow('Unauthorized');
    fixture.userId = 'owner-a';
    await updateHomepageSettings({ data: { kind: 'page', page: 'agent' } });
    for (const invalid of [
      { kind: 'page', page: 'apps', userId: 'owner-b' },
      { kind: 'page', page: '//outside.test' },
      { kind: 'app', appId: 'missing', entryHash: null },
      { kind: 'dashboard', dashboardId: 'missing' },
    ]) {
      await expect(
        updateHomepageSettings({ data: invalid as HomepageTarget }),
      ).rejects.toThrow(/Unrecognized key|Invalid option|no longer available/);
    }
    expect(await getHomepageDestination()).toBe('/agent');
    fixture.userId = 'owner-b';
    expect(await getHomepageDestination()).toBe('/dashboard');
  });

  it('supports every platform page and a stable Dashboard identity', async () => {
    for (const { value } of HOMEPAGE_PAGES) {
      await updateHomepageSettings({ data: { kind: 'page', page: value } });
      expect(await getHomepageDestination()).toBe(`/${value}`);
    }
    await updateHomepageSettings({
      data: { kind: 'dashboard', dashboardId: 'dashboard-one' },
    });
    expect(await getHomepageDestination()).toBe('/dashboard/dashboard-one');
    await db.delete(schema.dashboards);
    expect(await getHomepageDestination()).toBe('/dashboard');
    expect((await getHomepageSettings()).available).toBe(false);
    expect((await getHomepageSettings()).homepage).toEqual({
      kind: 'dashboard',
      dashboardId: 'dashboard-one',
    });
  });

  it('resolves Apps by immutable ID, normalizes internal entry hashes and preserves choices through archive/restore', async () => {
    await updateHomepageSettings({
      data: {
        kind: 'app',
        appId: 'app-one',
        entryHash: ' #/settings?tab=profile ',
      },
    });
    expect(await getHomepageDestination()).toBe(
      '/app/first-slug#/settings?tab=profile',
    );
    await db
      .update(schema.apps)
      .set({ slug: 'new-slug' })
      .where(eq(schema.apps.id, 'app-one'));
    await db.insert(schema.apps).values({
      id: 'replacement-app',
      slug: 'first-slug',
      name: 'Other App',
      status: 'deployed',
      capabilities,
    });
    expect(await getHomepageDestination()).toBe(
      '/app/new-slug#/settings?tab=profile',
    );
    await db
      .update(schema.apps)
      .set({ status: 'building' })
      .where(eq(schema.apps.id, 'app-one'));
    expect(await getHomepageDestination()).toBe(
      '/app/new-slug#/settings?tab=profile',
    );
    await db
      .update(schema.apps)
      .set({ status: 'archived' })
      .where(eq(schema.apps.id, 'app-one'));
    expect(await getHomepageDestination()).toBe('/dashboard');
    expect((await getHomepageSettings()).available).toBe(false);
    await expect(
      updateHomepageSettings({
        data: {
          kind: 'app',
          appId: 'app-one',
          entryHash: null,
        },
      }),
    ).rejects.toThrow('no longer available');
    await db
      .update(schema.apps)
      .set({ status: 'deployed' })
      .where(eq(schema.apps.id, 'app-one'));
    expect(await getHomepageDestination()).toBe(
      '/app/new-slug#/settings?tab=profile',
    );
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: 999 })
      .where(eq(schema.deployments.id, 'deployment-one'));
    expect(await getHomepageDestination()).toBe('/dashboard');
    expect((await getHomepageSettings()).apps).toEqual([]);
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: 2 })
      .where(eq(schema.deployments.id, 'deployment-one'));
    expect(await getHomepageDestination()).toBe(
      '/app/new-slug#/settings?tab=profile',
    );
    await db
      .update(schema.apps)
      .set({ capabilities: { ...capabilities, frontend: false } })
      .where(eq(schema.apps.id, 'app-one'));
    expect(await getHomepageDestination()).toBe('/dashboard');
    await db.delete(schema.apps).where(eq(schema.apps.id, 'app-one'));
    expect(await getHomepageDestination()).toBe('/dashboard');
    expect((await getHomepageSettings()).homepage).toEqual({
      kind: 'app',
      appId: 'app-one',
      entryHash: '/settings?tab=profile',
    });
  });
});
