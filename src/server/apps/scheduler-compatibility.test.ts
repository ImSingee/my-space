import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';
import { APP_COMPATIBILITY_UPDATE_MESSAGE } from '~/app-compatibility';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('./runtime', () => ({
  callAppBackend: vi.fn<() => Promise<unknown>>(),
}));

const { db, schema } = await import('~/db');
const { callAppBackend } = await import('./runtime');
const { listCronJobs, runCronJobNow } = await import('./scheduler');

const APP_ID = 'cron-compatibility';
const DEPLOYMENT_ID = 'cron-deployment';

beforeEach(async () => {
  vi.clearAllMocks();
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

it('preserves unsupported cron metadata while blocking invocation', async () => {
  await expect(listCronJobs(APP_ID)).resolves.toHaveLength(1);

  await db
    .update(schema.deployments)
    .set({ compatibilityVersion: 0 })
    .where(eq(schema.deployments.id, DEPLOYMENT_ID));

  await expect(listCronJobs(APP_ID)).resolves.toMatchObject([
    {
      name: 'refresh',
      schedule: '0 * * * *',
      path: '/refresh',
    },
  ]);
  await expect(runCronJobNow(APP_ID, 'refresh')).rejects.toMatchObject({
    name: 'AppError',
    message: APP_COMPATIBILITY_UPDATE_MESSAGE,
    status: 503,
  });
  expect(callAppBackend).not.toHaveBeenCalled();
});
