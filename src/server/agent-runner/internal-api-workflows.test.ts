import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateWorkflowInput,
  CreateWorkflowResult,
} from '~server/workflows/scaffold';

const mocks = vi.hoisted(() => ({
  findWorkflow:
    vi.fn<
      (query: {
        where: { id: string };
      }) =>
        | Promise<{ id: string; createdAt: Date } | undefined>
        | { id: string; createdAt: Date }
        | undefined
    >(),
  listWorkflowsForAgent: vi.fn<() => Promise<unknown[]>>(),
  getWorkflowDetailForAgent:
    vi.fn<(workflowId: string) => Promise<unknown> | unknown>(),
  createWorkflow:
    vi.fn<(input: CreateWorkflowInput) => Promise<CreateWorkflowResult>>(),
  workflowMasterCommit: vi.fn<(workflowId: string) => Promise<string | null>>(),
  exportWorkflowMasterBundle:
    vi.fn<(workflowId: string) => Promise<Buffer | null>>(),
  stageWorkflowBundleCheckout:
    vi.fn<
      (
        workflowId: string,
        bundle: Buffer,
      ) => Promise<{ dir: string; cleanup: () => Promise<void> | void }>
    >(),
  deployWorkflow:
    vi.fn<(workflowId: string, options: unknown) => Promise<unknown>>(),
  rollbackWorkflowToVersion:
    vi.fn<(workflowId: string, version: number) => Promise<unknown>>(),
}));

vi.mock('~/db', () => ({
  db: {
    query: {
      workflows: { findFirst: mocks.findWorkflow },
    },
  },
}));

vi.mock('~server/workflows/inspect', () => ({
  listWorkflowsForAgent: mocks.listWorkflowsForAgent,
  getWorkflowDetailForAgent: mocks.getWorkflowDetailForAgent,
}));

vi.mock('~server/workflows/scaffold', () => ({
  createWorkflow: mocks.createWorkflow,
}));

vi.mock('~server/workflows/git', () => ({
  workflowMasterCommit: mocks.workflowMasterCommit,
  exportWorkflowMasterBundle: mocks.exportWorkflowMasterBundle,
  stageWorkflowBundleCheckout: mocks.stageWorkflowBundleCheckout,
}));

vi.mock('~server/workflows/deploy', () => ({
  deployWorkflow: mocks.deployWorkflow,
}));

vi.mock('~server/workflows/manage', () => ({
  rollbackWorkflowToVersion: mocks.rollbackWorkflowToVersion,
}));

const { handleInternalApiRequest } = await import('./internal-api');

function request(url: string, method: 'GET' | 'POST'): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  return req;
}

function response(): http.ServerResponse {
  const res = new EventEmitter() as http.ServerResponse;
  let ended = false;
  Object.defineProperty(res, 'writableEnded', { get: () => ended });
  res.writeHead = vi.fn<() => http.ServerResponse>(
    () => res,
  ) as typeof res.writeHead;
  res.end = vi.fn<() => http.ServerResponse>(() => {
    ended = true;
    return res;
  }) as typeof res.end;
  return res;
}

function sendBody(req: http.IncomingMessage, body: unknown): void {
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
}

async function callRoute(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<http.ServerResponse> {
  const req = request(url, method);
  const res = response();
  const handling = handleInternalApiRequest(req, res);
  if (body !== undefined) {
    await vi.waitFor(() => {
      if (!res.writableEnded && req.listenerCount('data') === 0) {
        throw new Error('Request body listener is not ready.');
      }
    });
    if (!res.writableEnded) sendBody(req, body);
  }
  await handling;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findWorkflow.mockImplementation(async ({ where }) =>
    where.id === '01immutableworkflow'
      ? {
          id: '01immutableworkflow',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        }
      : undefined,
  );
  mocks.getWorkflowDetailForAgent.mockImplementation(async (workflowId) =>
    workflowId === '01immutableworkflow'
      ? {
          id: workflowId,
          slug: 'human-readable-slug',
          name: 'Example Workflow',
        }
      : null,
  );
  mocks.workflowMasterCommit.mockResolvedValue('master-commit');
  mocks.exportWorkflowMasterBundle.mockResolvedValue(Buffer.from('bundle'));
  mocks.stageWorkflowBundleCheckout.mockResolvedValue({
    dir: '/tmp/staged-workflow',
    cleanup: vi.fn<() => void>(),
  });
  mocks.deployWorkflow.mockResolvedValue({
    deploymentId: 'deployment-one',
    version: 1,
    compatibilityVersion: 1,
    normalized: { id: '01immutableworkflow' },
  });
  mocks.rollbackWorkflowToVersion.mockResolvedValue({
    version: 1,
    compatibility: {
      version: 1,
      latestVersion: 1,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    },
  });
});

describe('Agent Runner Workflow collection API', () => {
  it('returns slug in list results and creates from slug', async () => {
    const summary = {
      id: '01immutableworkflow',
      slug: 'human-readable-slug',
      name: 'Example Workflow',
      status: 'draft',
      liveVersion: null,
      webhook: false,
      cronCount: 0,
    };
    mocks.listWorkflowsForAgent.mockResolvedValue([summary]);
    mocks.createWorkflow.mockResolvedValue({
      id: '01createdworkflow',
      slug: 'created-workflow',
      name: 'Created Workflow',
      files: [],
    });

    const listed = await callRoute('/internal/api/workflows', 'GET');
    const created = await callRoute('/internal/api/workflows', 'POST', {
      slug: 'created-workflow',
      name: 'Created Workflow',
    });

    expect(listed.end).toHaveBeenCalledWith(JSON.stringify([summary]));
    expect(mocks.createWorkflow).toHaveBeenCalledWith({
      slug: 'created-workflow',
      name: 'Created Workflow',
    });
    expect(created.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
  });
});

const workflowRouteCases = [
  {
    name: 'details',
    suffix: '',
    method: 'GET' as const,
    assertId: () =>
      expect(mocks.getWorkflowDetailForAgent).toHaveBeenCalledWith(
        '01immutableworkflow',
      ),
  },
  {
    name: 'source',
    suffix: '/source',
    method: 'GET' as const,
    assertId: () =>
      expect(mocks.workflowMasterCommit).toHaveBeenCalledWith(
        '01immutableworkflow',
      ),
  },
  {
    name: 'deploy',
    suffix: '/deploy',
    method: 'POST' as const,
    body: {
      message: 'Deploy by id',
      generation: '2026-09-01T00:00:00.000Z',
      bundleBase64: Buffer.from('bundle').toString('base64'),
    },
    assertId: () =>
      expect(mocks.stageWorkflowBundleCheckout).toHaveBeenCalledWith(
        '01immutableworkflow',
        Buffer.from('bundle'),
      ),
  },
  {
    name: 'rollback',
    suffix: '/rollback',
    method: 'POST' as const,
    body: { version: 1 },
    assertId: () =>
      expect(mocks.rollbackWorkflowToVersion).toHaveBeenCalledWith(
        '01immutableworkflow',
        1,
      ),
  },
];

describe('Agent Runner ID-only Workflow paths', () => {
  it.each(workflowRouteCases)('serves $name by immutable id', async (route) => {
    const res = await callRoute(
      `/internal/api/workflows/01immutableworkflow${route.suffix}`,
      route.method,
      route.body,
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
    route.assertId();
  });

  it.each(workflowRouteCases)(
    'returns 404 for a slug-only $name path',
    async (route) => {
      const res = await callRoute(
        `/internal/api/workflows/human-readable-slug${route.suffix}`,
        route.method,
        route.body,
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        'content-type': 'application/json',
      });
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({
          error: 'Workflow "human-readable-slug" not found.',
        }),
      );
    },
  );

  it('accepts a legacy kebab-case immutable Workflow id', async () => {
    mocks.getWorkflowDetailForAgent.mockImplementation(async (workflowId) =>
      workflowId === 'legacy-kebab-id'
        ? {
            id: workflowId,
            slug: 'current-slug',
            name: 'Legacy Workflow',
          }
        : null,
    );

    const res = await callRoute(
      '/internal/api/workflows/legacy-kebab-id',
      'GET',
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
  });

  it('returns compatibility in deploy and rollback protocol responses', async () => {
    const deploy = await callRoute(
      '/internal/api/workflows/01immutableworkflow/deploy',
      'POST',
      {
        message: 'Deploy by id',
        generation: '2026-09-01T00:00:00.000Z',
        bundleBase64: Buffer.from('bundle').toString('base64'),
      },
    );
    const rollback = await callRoute(
      '/internal/api/workflows/01immutableworkflow/rollback',
      'POST',
      { version: 1 },
    );

    expect(deploy.end).toHaveBeenCalledWith(
      JSON.stringify({
        deploymentId: 'deployment-one',
        version: 1,
        compatibilityVersion: 1,
        normalized: { id: '01immutableworkflow' },
      }),
    );
    expect(rollback.end).toHaveBeenCalledWith(
      JSON.stringify({
        version: 1,
        compatibility: {
          version: 1,
          latestVersion: 1,
          minimumSupportedVersion: 1,
          isSupported: true,
          isLatest: true,
        },
      }),
    );
  });
});
