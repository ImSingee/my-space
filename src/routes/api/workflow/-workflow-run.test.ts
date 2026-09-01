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

const WORKFLOW_ID = '01immutableworkflow';
const WORKFLOW_SLUG = 'daily-digest';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findWorkflow.mockImplementation(async (options) => {
    if (
      (options as { where?: { id?: string } } | undefined)?.where?.id !==
      WORKFLOW_ID
    ) {
      return undefined;
    }
    return {
      id: WORKFLOW_ID,
      slug: WORKFLOW_SLUG,
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
    };
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
      request: new Request(
        `https://hatch.test/api/workflow/${WORKFLOW_ID}/run`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hatch-secret': 'workflow-secret',
          },
          body: JSON.stringify({ limit: 5 }),
        },
      ),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      runId: 'run-1',
      status: 'queued',
    });
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(WORKFLOW_ID, {
      trigger: 'webhook',
      input: { limit: 5 },
    });
  });

  it('keeps coercing GET query input at the new URL', async () => {
    const response = await handle({
      request: new Request(
        `https://hatch.test/api/workflow/${WORKFLOW_ID}/run?` +
          'secret=workflow-secret&limit=7&dryRun=true',
      ),
    });

    expect(response.status).toBe(202);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(WORKFLOW_ID, {
      trigger: 'webhook',
      input: { limit: 7, dryRun: true },
    });
  });

  it('does not resolve the mutable slug at the technical run URL', async () => {
    const response = await handle({
      request: new Request(
        `https://hatch.test/api/workflow/${WORKFLOW_SLUG}/run?` +
          'secret=workflow-secret',
      ),
    });

    expect(response.status).toBe(404);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('authenticates before returning the compatibility boundary', async () => {
    const { WorkflowDeploymentCompatibilityError } =
      await import('~server/workflows/compatibility');
    mocks.startWorkflowRun.mockRejectedValue(
      new WorkflowDeploymentCompatibilityError(
        'This Workflow cannot run on the current platform compatibility policy.',
      ),
    );

    const forbidden = await handle({
      request: new Request(
        `https://hatch.test/api/workflow/${WORKFLOW_ID}/run`,
        { method: 'POST', body: '{}' },
      ),
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.text()).resolves.not.toMatch(/cannot run/);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();

    const response = await handle({
      request: new Request(
        `https://hatch.test/api/workflow/${WORKFLOW_ID}/run`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hatch-secret': 'workflow-secret',
          },
          body: '{}',
        },
      ),
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toMatch(/cannot run/);
    expect(mocks.startWorkflowRun).toHaveBeenCalledOnce();
  });

  it.each([
    `https://hatch.test/api/workflow-hooks/${WORKFLOW_ID}`,
    `https://hatch.test/api/workflow/${WORKFLOW_ID}/run/extra`,
  ])('rejects non-canonical run URL %s before reading state', async (url) => {
    const response = await handle({ request: new Request(url) });

    expect(response.status).toBe(404);
    expect(mocks.findWorkflow).not.toHaveBeenCalled();
    expect(mocks.findDeployment).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });
});
