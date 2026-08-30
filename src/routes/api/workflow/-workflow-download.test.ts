import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options: unknown) => Promise<unknown>>(),
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
  artifactDir: vi.fn<(workflowId: string, deploymentId: string) => string>(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock('node:fs', () => ({
  promises: { readFile: mocks.readFile },
}));
vi.mock('~agent/paths', () => ({
  workflowDeploymentArtifactDir: mocks.artifactDir,
}));
vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      workflowDeployments: { findFirst: mocks.findDeployment },
    },
  },
}));

const { handle } = await import('./$workflowId/download');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.findDeployment.mockResolvedValue({
    id: 'deployment-1',
    workflowId: 'daily-digest',
    version: 3,
  });
  mocks.artifactDir.mockReturnValue('/artifacts/daily-digest/deployment-1');
  mocks.readFile.mockResolvedValue(Buffer.from('workflow bundle'));
});

describe('Workflow download route', () => {
  it('serves deployments from the singular workflow API namespace', async () => {
    const response = await handle({
      request: new Request(
        'https://hatch.test/api/workflow/daily-digest/download?' +
          'deployment=deployment-1',
      ),
    });

    expect(response.status).toBe(200);
    expect(mocks.findDeployment).toHaveBeenCalledWith({
      where: { id: 'deployment-1', workflowId: 'daily-digest' },
    });
    expect(mocks.artifactDir).toHaveBeenCalledWith(
      'daily-digest',
      'deployment-1',
    );
    expect(mocks.readFile).toHaveBeenCalledWith(
      '/artifacts/daily-digest/deployment-1/workflow.js',
    );
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="daily-digest-v3.js"',
    );
    await expect(response.text()).resolves.toBe('workflow bundle');
  });

  it('rejects the former plural workflow API namespace', async () => {
    const response = await handle({
      request: new Request(
        'https://hatch.test/api/workflows/daily-digest/download?' +
          'deployment=deployment-1',
      ),
    });

    expect(response.status).toBe(404);
    expect(mocks.findDeployment).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
