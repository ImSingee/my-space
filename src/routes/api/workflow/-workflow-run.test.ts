import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findWorkflow: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
  startWorkflowRun:
    vi.fn<
      (
        id: string,
        options: { trigger: 'webhook'; input: unknown },
      ) => Promise<{ runId: string; status: string }>
    >(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      workflows: { findFirst: mocks.findWorkflow },
      workflowDeployments: { findFirst: mocks.findDeployment },
    },
  },
}));
vi.mock('~server/workflows/execute', () => ({
  startWorkflowRun: mocks.startWorkflowRun,
}));

const { handle } = await import('./$workflowId/run');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findWorkflow.mockResolvedValue({
    id: 'daily-digest',
    status: 'deployed',
    webhookSecret: 'workflow-secret',
    currentDeploymentId: 'deployment-1',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        dryRun: { type: 'boolean' },
      },
    },
  });
  mocks.findDeployment.mockResolvedValue({
    manifestNormalized: {
      triggers: { webhook: { enabled: true } },
    },
  });
  mocks.startWorkflowRun.mockResolvedValue({
    runId: 'run-1',
    status: 'queued',
  });
});

describe('Workflow webhook run route', () => {
  it('starts a run from JSON at the singular Workflow API URL', async () => {
    const response = await handle({
      request: new Request('https://hatch.test/api/workflow/daily-digest/run', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hatch-secret': 'workflow-secret',
        },
        body: JSON.stringify({ limit: 5 }),
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      runId: 'run-1',
      status: 'queued',
    });
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith('daily-digest', {
      trigger: 'webhook',
      input: { limit: 5 },
    });
  });

  it('keeps coercing GET query input at the new URL', async () => {
    const response = await handle({
      request: new Request(
        'https://hatch.test/api/workflow/daily-digest/run?' +
          'secret=workflow-secret&limit=7&dryRun=true',
      ),
    });

    expect(response.status).toBe(202);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith('daily-digest', {
      trigger: 'webhook',
      input: { limit: 7, dryRun: true },
    });
  });

  it.each([
    'https://hatch.test/api/workflow-hooks/daily-digest',
    'https://hatch.test/api/workflow/daily-digest/run/extra',
  ])('rejects non-canonical run URL %s before reading state', async (url) => {
    const response = await handle({ request: new Request(url) });

    expect(response.status).toBe(404);
    expect(mocks.findWorkflow).not.toHaveBeenCalled();
    expect(mocks.findDeployment).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });
});
