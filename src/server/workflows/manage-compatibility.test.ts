import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn<() => Promise<void>>(),
  access: vi.fn<() => Promise<void>>(),
  findWorkflow: vi.fn<() => Promise<unknown>>(),
  findDeployment: vi.fn<() => Promise<unknown>>(),
  moveMasterToDeploymentTag: vi.fn<() => Promise<string>>(),
  reloadScheduler: vi.fn<() => Promise<void>>(),
  updates: [] as unknown[],
}));

vi.mock('node:fs', () => ({
  promises: {
    access: mocks.access,
    rm: vi.fn<() => Promise<void>>(),
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn<() => Record<string, never>>(() => ({})),
}));
vi.mock('~agent/paths', () => ({
  workflowArtifactsDir: (id: string) => `/workspace/artifacts/${id}`,
  workflowCurrentDir: (id: string) => `/workspace/current/${id}`,
  workflowDeploymentArtifactDir: (id: string, deploymentId: string) =>
    `/workspace/artifacts/${id}/${deploymentId}`,
  workflowRepoDir: (id: string) => `/workspace/repos/${id}.git`,
}));
vi.mock('~/db', () => {
  const update = () => ({
    set: (value: unknown) => {
      mocks.updates.push(value);
      return { where: () => Promise.resolve() };
    },
  });
  const tx = { update, acquire: mocks.acquire };
  return {
    db: {
      query: {
        workflows: { findFirst: mocks.findWorkflow },
        workflowDeployments: { findFirst: mocks.findDeployment },
      },
      transaction: async (callback: (transaction: unknown) => unknown) =>
        callback(tx),
    },
    schema: { workflows: { id: 'workflows.id' } },
  };
});
vi.mock('./deploy', () => ({
  workflowDeployLock: {
    withLock: (_id: string, callback: () => unknown) => callback(),
    acquire: mocks.acquire,
  },
}));
vi.mock('./git', () => ({
  moveMasterToDeploymentTag: mocks.moveMasterToDeploymentTag,
}));
vi.mock('./manifest', () => ({ isValidWorkflowId: () => true }));
vi.mock('./scheduler', () => ({
  reloadWorkflowScheduler: mocks.reloadScheduler,
}));

const { rollbackWorkflow, rollbackWorkflowToVersion } =
  await import('./manage');

const WORKFLOW_ID = 'compatibility-workflow';
const DEPLOYMENT_ID = 'unsupported-deployment';

describe('Workflow rollback compatibility boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updates.length = 0;
    mocks.access.mockResolvedValue();
    mocks.acquire.mockResolvedValue();
    mocks.moveMasterToDeploymentTag.mockResolvedValue('restored-commit');
    mocks.reloadScheduler.mockResolvedValue();
    mocks.findWorkflow.mockResolvedValue({
      id: WORKFLOW_ID,
      name: 'Compatibility Workflow',
      currentDeploymentId: 'current-deployment',
    });
    mocks.findDeployment.mockResolvedValue({
      id: DEPLOYMENT_ID,
      workflowId: WORKFLOW_ID,
      version: 1,
      compatibilityVersion: 0,
      status: 'deployed',
      sourceTag: 'deploy/v1',
      manifestNormalized: {
        name: 'Compatibility Workflow v1',
        description: 'Old source',
      },
      inputSchema: { type: 'object' },
    });
  });

  it('blocks public rollback before mutation but lets Agent restore it', async () => {
    await expect(
      rollbackWorkflow(WORKFLOW_ID, DEPLOYMENT_ID),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.moveMasterToDeploymentTag).not.toHaveBeenCalled();

    await expect(
      rollbackWorkflowToVersion(WORKFLOW_ID, 1),
    ).resolves.toMatchObject({
      version: 1,
      compatibility: { version: 0, isSupported: false },
    });
    expect(mocks.moveMasterToDeploymentTag).toHaveBeenCalledWith(
      WORKFLOW_ID,
      'deploy/v1',
    );
    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        currentDeploymentId: DEPLOYMENT_ID,
        currentSourceCommit: 'restored-commit',
      }),
    );
    expect(mocks.reloadScheduler).toHaveBeenCalledOnce();
  });

  it('requires a platform update before public rollback to a newer version', async () => {
    mocks.findDeployment.mockResolvedValue({
      id: DEPLOYMENT_ID,
      workflowId: WORKFLOW_ID,
      version: 3,
      compatibilityVersion: 2,
      status: 'deployed',
      sourceTag: 'deploy/v3',
      manifestNormalized: {
        name: 'Compatibility Workflow v3',
        description: 'Newer source',
      },
      inputSchema: { type: 'object' },
    });

    await expect(
      rollbackWorkflow(WORKFLOW_ID, DEPLOYMENT_ID),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/newer.*Update the platform/),
    });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.moveMasterToDeploymentTag).not.toHaveBeenCalled();

    await expect(
      rollbackWorkflowToVersion(WORKFLOW_ID, 3),
    ).resolves.toMatchObject({
      version: 3,
      compatibility: { version: 2, isSupported: false },
    });
    expect(mocks.moveMasterToDeploymentTag).toHaveBeenCalledWith(
      WORKFLOW_ID,
      'deploy/v3',
    );
  });
});
