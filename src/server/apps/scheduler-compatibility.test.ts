import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('./runtime', () => ({
  callAppBackend: vi.fn<() => Promise<unknown>>(),
}));

const { db, schema } = await import('~/db');
const { listCronJobs, runCronJobNow } = await import('./scheduler');

const APP_ID = 'cron-compatibility';
const DEPLOYMENT_ID = 'cron-deployment';

beforeEach(async () => {
  await db.delete(schema.apps);
  await db.insert(schema.apps).values({
    id: APP_ID,
    slug: APP_ID,
    name: 'Cron compatibility',
    status: 'deployed',
    currentDeploymentId: DEPLOYMENT_ID,
    capabilities: {
      database: false,
      frontend: false,
      widgets: false,
      backend: true,
      cron: true,
      webhook: false,
      storage: false,
      kv: false,
      dataTable: false,
    },
  });
  await db.insert(schema.deployments).values({
    id: DEPLOYMENT_ID,
    appId: APP_ID,
    status: 'deployed',
    manifestNormalized: {
      cron: [
        {
          name: 'refresh',
          schedule: '0 * * * *',
          path: '/refresh',
        },
      ],
    },
  });
});

it('keeps legacy v1 cron live while filtering an unsupported deployment', async () => {
  await expect(listCronJobs(APP_ID)).resolves.toHaveLength(1);

  await db
    .update(schema.deployments)
    .set({ compatibilityVersion: 0 })
    .where(eq(schema.deployments.id, DEPLOYMENT_ID));

  await expect(listCronJobs(APP_ID)).resolves.toEqual([]);
  await expect(runCronJobNow(APP_ID, 'refresh')).rejects.toThrow('not found');
});
