import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKFLOW_COMPATIBILITY_UPDATE_MESSAGE } from '~/workflow-compatibility';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { assertSupportedWorkflowCompatibility } =
  await import('./compatibility');
const { startWorkflowRun } = await import('./execute');
const { getWorkflowCallability } = await import('./external');
const { listWorkflowCronJobs, loadWorkflowCronSchedule } =
  await import('./scheduler');

const WORKFLOW_ID = 'compatibility-workflow';
const DEPLOYMENT_ID = 'compatibility-deployment';

beforeEach(async () => {
  await db.delete(schema.workflows);
  await db.insert(schema.workflows).values({
    id: WORKFLOW_ID,
    slug: WORKFLOW_ID,
    name: 'Compatibility Workflow',
    webhookSecret: 'workflow-secret',
  });
});

async function seedDeployment(compatibilityVersion = 1) {
  await db.insert(schema.workflowDeployments).values({
    id: DEPLOYMENT_ID,
    workflowId: WORKFLOW_ID,
    version: 1,
    compatibilityVersion,
    status: 'deployed',
    manifestNormalized: {
      id: WORKFLOW_ID,
      name: 'Compatibility Workflow',
      description: '',
      entry: 'workflow.ts',
      triggers: {
        cron: [
          {
            name: 'hourly',
            schedule: '0 * * * *',
            input: {},
          },
        ],
        webhook: {
          enabled: true,
          url: `/api/workflow/${WORKFLOW_ID}/run`,
        },
      },
    },
  });
  await db
    .update(schema.workflows)
    .set({
      status: 'deployed',
      currentDeploymentId: DEPLOYMENT_ID,
      inputSchema: { type: 'object' },
    })
    .where(eq(schema.workflows.id, WORKFLOW_ID));
}

describe('Workflow deployment compatibility storage', () => {
  it('has no database default or legacy null fallback', async () => {
    const column = await db.execute(sql`
      select
        column_default as "columnDefault",
        is_nullable as "isNullable"
      from information_schema.columns
      where table_name = 'workflow_deployments'
        and column_name = 'compatibility_version'
    `);

    // The production postgres-js client is typed as a row list, while this
    // test's PGlite client wraps raw execute results in `rows` at runtime.
    const rows = (
      column as unknown as {
        rows: { columnDefault: string | null; isNullable: string }[];
      }
    ).rows;
    expect(rows).toEqual([{ columnDefault: null, isNullable: 'NO' }]);
    await expect(
      db.execute(sql`
        insert into workflow_deployments (id, workflow_id)
        values ('missing-compatibility', ${WORKFLOW_ID})
      `),
    ).rejects.toThrow(/Failed query/);
  });

  it('reads and enforces the explicitly stored version', async () => {
    await seedDeployment();

    expect(assertSupportedWorkflowCompatibility(1)).toMatchObject({
      version: 1,
      minimumSupportedVersion: 1,
      latestVersion: 1,
      isSupported: true,
      isLatest: true,
    });
    await expect(getWorkflowCallability(WORKFLOW_ID)).resolves.toMatchObject({
      state: 'callable',
      workflow: { id: WORKFLOW_ID },
    });
  });
});

describe('Workflow compatibility runtime boundary', () => {
  it('preserves metadata but blocks every invocation path below minimum', async () => {
    await seedDeployment(0);

    await expect(listWorkflowCronJobs(WORKFLOW_ID)).resolves.toMatchObject([
      { name: 'hourly', schedule: '0 * * * *' },
    ]);
    await expect(loadWorkflowCronSchedule()).resolves.toEqual([
      { ownerId: WORKFLOW_ID, jobs: [] },
    ]);
    await expect(getWorkflowCallability(WORKFLOW_ID)).resolves.toMatchObject({
      state: 'unsupported',
      workflow: {
        id: WORKFLOW_ID,
        secret: 'workflow-secret',
        path: `/api/workflow/${WORKFLOW_ID}/run`,
      },
      compatibility: { version: 0 },
    });
    await expect(
      startWorkflowRun(WORKFLOW_ID, { trigger: 'manual', input: {} }),
    ).rejects.toMatchObject({
      name: 'AppError',
      message: WORKFLOW_COMPATIBILITY_UPDATE_MESSAGE,
      status: 503,
    });
    await expect(db.query.workflowRuns.findMany()).resolves.toEqual([]);
  });

  it('blocks deployments newer than the platform with upgrade guidance', async () => {
    await seedDeployment(2);

    await expect(listWorkflowCronJobs(WORKFLOW_ID)).resolves.toMatchObject([
      { name: 'hourly', schedule: '0 * * * *' },
    ]);
    await expect(loadWorkflowCronSchedule()).resolves.toEqual([
      { ownerId: WORKFLOW_ID, jobs: [] },
    ]);
    await expect(getWorkflowCallability(WORKFLOW_ID)).resolves.toMatchObject({
      state: 'unsupported',
      compatibility: { version: 2 },
    });
    await expect(
      startWorkflowRun(WORKFLOW_ID, { trigger: 'manual', input: {} }),
    ).rejects.toMatchObject({
      name: 'AppError',
      message: expect.stringMatching(/newer.*Update the platform/),
      status: 503,
    });
    await expect(db.query.workflowRuns.findMany()).resolves.toEqual([]);
  });
});
