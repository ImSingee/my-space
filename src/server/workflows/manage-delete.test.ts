import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteRow: vi.fn<() => { where: () => Promise<void> }>(),
  fsRm: vi.fn<
    (
      target: string,
      options: { recursive: boolean; force: boolean },
    ) => Promise<void>
  >(),
  killActiveRuns: vi.fn<(workflowId: string) => Promise<void>>(),
  reloadScheduler: vi.fn<() => Promise<void>>(),
}));

vi.mock('node:fs', () => ({
  promises: {
    access: vi.fn<() => Promise<void>>(),
    rm: mocks.fsRm,
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn<(left: unknown, right: unknown) => Record<string, never>>(
    () => ({}),
  ),
}));
vi.mock('~agent/paths', () => ({
  workflowArtifactsDir: (id: string) => `/workspace/artifacts/${id}`,
  workflowCurrentDir: (id: string) => `/workspace/current/${id}`,
  workflowDeploymentArtifactDir: (id: string, deploymentId: string) =>
    `/workspace/artifacts/${id}/${deploymentId}`,
  workflowRepoDir: (id: string) => `/workspace/repos/${id}.git`,
}));
vi.mock('~/db', () => ({
  db: {
    delete: mocks.deleteRow,
  },
  schema: {
    workflows: { id: 'workflows.id' },
  },
}));
vi.mock('./deploy', () => ({
  workflowDeployLock: {},
}));
vi.mock('./execute', () => ({
  killActiveWorkflowRuns: mocks.killActiveRuns,
}));
vi.mock('./git', () => ({
  moveMasterToDeploymentTag: vi.fn<() => Promise<string>>(),
}));
vi.mock('./manifest', () => ({
  isValidWorkflowId: () => true,
}));
vi.mock('./scheduler', () => ({
  reloadWorkflowScheduler: mocks.reloadScheduler,
}));

const { deleteWorkflow } = await import('./manage');

describe('Workflow deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteRow.mockReturnValue({
      where: () => Promise.resolve(),
    });
    mocks.fsRm.mockResolvedValue();
    mocks.killActiveRuns.mockResolvedValue();
    mocks.reloadScheduler.mockResolvedValue();
  });

  it('deletes Platform state without touching conversation workspaces', async () => {
    await expect(deleteWorkflow('workflow-a')).resolves.toEqual({ ok: true });

    expect(mocks.killActiveRuns).toHaveBeenCalledWith('workflow-a');
    expect(mocks.deleteRow).toHaveBeenCalledOnce();
    expect(mocks.fsRm).toHaveBeenCalledTimes(3);
    expect(mocks.fsRm).toHaveBeenCalledWith('/workspace/repos/workflow-a.git', {
      recursive: true,
      force: true,
    });
    expect(
      mocks.fsRm.mock.calls.some(([target]) =>
        target.startsWith('/workspace/agents/'),
      ),
    ).toBe(false);
  });
});
