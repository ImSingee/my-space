import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_WORKFLOW_COMPATIBILITY_VERSION } from '~/workflow-compatibility';

const mocks = vi.hoisted(() => ({
  root: `/tmp/hatch-workflow-deploy-compatibility-${process.pid}`,
  compatibilityVersion: 1,
  buildWorkflow: vi.fn<(id: string, options: unknown) => Promise<unknown>>(),
  publishDeploymentSource:
    vi.fn<
      (id: string, sourceDir: string, version: number) => Promise<unknown>
    >(),
  reloadWorkflowScheduler: vi.fn<() => Promise<void>>(),
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('~agent/paths', () => ({
  WORKFLOW_BUILD_WORK_DIR: `${mocks.root}/work`,
  workflowDeploymentArtifactDir: (workflowId: string, deploymentId: string) =>
    `${mocks.root}/artifacts/${workflowId}/${deploymentId}`,
}));

vi.mock('~server/deploy-lock', () => ({
  createDeployLock: () => ({
    withLock: async <T>(_id: string, run: () => Promise<T>): Promise<T> =>
      run(),
    acquire: async (): Promise<void> => {},
  }),
  workspaceRelative: (value: string) => value,
}));

vi.mock('./build', () => ({ buildWorkflow: mocks.buildWorkflow }));
vi.mock('./git', () => ({
  assertDeployableWorktree: vi.fn<() => Promise<void>>(),
  deleteDeploymentTag: vi.fn<() => Promise<void>>(),
  prepareDeployCheckout: vi.fn<() => Promise<string>>(),
  publishDeploymentSource: mocks.publishDeploymentSource,
}));
vi.mock('./scheduler', () => ({
  reloadWorkflowScheduler: mocks.reloadWorkflowScheduler,
}));

const { db, schema } = await import('~/db');
const { deployWorkflow } = await import('./deploy');

const WORKFLOW_ID = 'workflow-deploy-compatibility';

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.compatibilityVersion = LATEST_WORKFLOW_COMPATIBILITY_VERSION;
  mocks.reloadWorkflowScheduler.mockResolvedValue();
  mocks.publishDeploymentSource.mockResolvedValue({
    tag: 'deploy/v1',
    commit: 'source-commit',
    repoPath: 'workflow-repos/example.git',
  });
  mocks.buildWorkflow.mockImplementation(async (id, rawOptions) => {
    const { outputDir } = rawOptions as { outputDir: string };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'workflow.js'), 'export {};');
    return {
      source: {
        id,
        name: 'Compatibility Workflow',
        description: '',
        compatibilityVersion: mocks.compatibilityVersion,
        entry: 'workflow.ts',
        network: [],
        triggers: { cron: [], webhook: false },
      },
      normalized: {
        id,
        name: 'Compatibility Workflow',
        description: '',
        entry: 'workflow.ts',
        network: [],
        triggers: {
          cron: [],
          webhook: { enabled: false, url: null },
        },
      },
      inputSchema: { type: 'object' },
      log: 'build complete',
    };
  });

  await fs.rm(mocks.root, { recursive: true, force: true });
  await db.delete(schema.workflows);
  await db.insert(schema.workflows).values({
    id: WORKFLOW_ID,
    slug: WORKFLOW_ID,
    name: 'Compatibility Workflow',
    status: 'draft',
  });
});

afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
});

describe('Workflow final deployment compatibility recording', () => {
  it('records and returns the manifest-selected compatibility version', async () => {
    const result = await deployWorkflow(WORKFLOW_ID, {
      sourceDir: '/source',
      message: 'Initial deployment',
    });

    expect(result.compatibilityVersion).toBe(
      LATEST_WORKFLOW_COMPATIBILITY_VERSION,
    );
    await expect(
      db.query.workflowDeployments.findFirst({
        where: { id: result.deploymentId },
        columns: { compatibilityVersion: true },
      }),
    ).resolves.toEqual({
      compatibilityVersion: LATEST_WORKFLOW_COMPATIBILITY_VERSION,
    });
    await expect(
      db.query.workflows.findFirst({
        where: { id: WORKFLOW_ID },
        columns: { currentDeploymentId: true },
      }),
    ).resolves.toEqual({ currentDeploymentId: result.deploymentId });
  });

  it('rejects a newer contract without recording or activating it', async () => {
    mocks.compatibilityVersion = LATEST_WORKFLOW_COMPATIBILITY_VERSION + 1;

    await expect(
      deployWorkflow(WORKFLOW_ID, {
        sourceDir: '/source',
        message: 'Unsupported deployment',
      }),
    ).rejects.toThrow(/newer than this platform's latest supported/);

    await expect(db.query.workflowDeployments.findMany()).resolves.toEqual([]);
    await expect(
      db.query.workflows.findFirst({
        where: { id: WORKFLOW_ID },
        columns: { currentDeploymentId: true },
      }),
    ).resolves.toEqual({ currentDeploymentId: null });
    expect(mocks.publishDeploymentSource).not.toHaveBeenCalled();
  });
});
