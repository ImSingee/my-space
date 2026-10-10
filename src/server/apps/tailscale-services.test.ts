import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';
const mocks = vi.hoisted(() => ({
  root: `/tmp/hatch-service-lifecycle-${process.pid}`,
  observed: vi.fn<() => unknown>(),
  refresh: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~agent/paths', () => ({
  appBuildDir: (id: string) => `${mocks.root}/${id}`,
  deploymentArtifactDir: () => `${mocks.root}/artifacts`,
  deploymentBuildDir: () => `${mocks.root}/versions`,
}));
vi.mock('../tailscale-manager', () => ({
  getTailscaleManager: () => ({
    getStatus: async () => ({ hostname: 'hatch' }),
    serviceSnapshot: mocks.observed,
    mutateServices: async (write: (hostname: string) => Promise<void>) => {
      await write('hatch');
      await mocks.refresh();
    },
  }),
}));
const { db, schema } = await import('~/db');
const { advertisedAppServices, activeAppService, saveAppService } =
  await import('./tailscale-services');
const appId = 'service-app';
const origin = 'https://notes.example.ts.net';
beforeEach(async () => {
  await db.delete(schema.apps);
  await fs.rm(mocks.root, { recursive: true, force: true });
  await fs.mkdir(`${mocks.root}/${appId}`, { recursive: true });
  await fs.writeFile(
    `${mocks.root}/${appId}/deployment.json`,
    JSON.stringify({ deploymentId: 'deploy-one' }),
  );
  await db.insert(schema.apps).values({
    id: appId,
    slug: 'notes',
    name: 'Notes',
    status: 'deployed',
    currentDeploymentId: 'deploy-one',
  });
  await db.insert(schema.deployments).values({
    id: 'deploy-one',
    appId,
    version: 1,
    compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
    manifestNormalized: { capabilities: { dataTable: false } },
  });
  await db
    .insert(schema.appTailscaleServices)
    .values({ appId, serviceName: 'notes', enabled: true, revision: 'one' });
  mocks.observed.mockReturnValue({
    appId,
    serviceName: 'notes',
    revision: 'one',
    state: 'ready',
    origin,
  });
});
afterAll(async () => fs.rm(mocks.root, { recursive: true, force: true }));
it('preserves a service identity across slug changes, and withdraws archived or missing artifacts', async () => {
  expect(await advertisedAppServices()).toHaveLength(1);
  expect(await activeAppService(appId, origin)).not.toBeNull();
  await db
    .update(schema.apps)
    .set({ slug: 'renamed' })
    .where(eq(schema.apps.id, appId));
  expect(await advertisedAppServices()).toEqual([
    { appId, serviceName: 'notes', revision: 'one', enabled: true },
  ]);
  await db
    .update(schema.apps)
    .set({ status: 'archived' })
    .where(eq(schema.apps.id, appId));
  expect(await advertisedAppServices()).toEqual([]);
  expect(await activeAppService(appId, origin)).toBeNull();
  await db
    .update(schema.apps)
    .set({ status: 'deployed' })
    .where(eq(schema.apps.id, appId));
  await fs.rm(`${mocks.root}/${appId}`, { recursive: true });
  expect(await advertisedAppServices()).toEqual([]);
  expect(await activeAppService(appId, origin)).toBeNull();
});
it('fails closed for stale observations and incompatible deployments, and does not rotate unchanged bindings', async () => {
  await saveAppService({ appId, serviceName: 'notes', enabled: true });
  expect(
    (await db.query.appTailscaleServices.findFirst({ where: { appId } }))
      ?.revision,
  ).toBe('one');
  await db.update(schema.appTailscaleServices).set({ revision: 'two' });
  expect(await activeAppService(appId, origin)).toBeNull();
  await db
    .update(schema.deployments)
    .set({ compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION + 1 });
  expect(await advertisedAppServices()).toEqual([]);
  await expect(
    saveAppService({ appId, serviceName: 'hatch', enabled: true }),
  ).rejects.toThrow(/node name/);
});
