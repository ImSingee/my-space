import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  proxyAppRequest:
    vi.fn<
      (
        id: string,
        request: Request,
        stripPrefix: string,
        forwardPrefix: string,
        options: unknown,
      ) => Promise<Response>
    >(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: { findFirst: mocks.findDeployment },
    },
  },
}));
vi.mock('~server/apps/runtime', () => ({
  proxyAppRequest: mocks.proxyAppRequest,
}));

import { handleRpcRequest } from './rpc';

describe('public app RPC route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-1',
      capabilities: { backend: true },
      signingSecret: 'signing-secret',
    });
    mocks.findDeployment.mockResolvedValue({ compatibilityVersion: null });
    mocks.proxyAppRequest.mockResolvedValue(new Response('proxied'));
  });

  it('strips the canonical RPC prefix', async () => {
    const request = new Request(
      'https://hatch.test/api/app/app-id/rpc/todos.list',
      {
        method: 'POST',
        body: '{}',
      },
    );

    const response = await handleRpcRequest({ request });

    expect(response.status).toBe(200);
    expect(mocks.proxyAppRequest).toHaveBeenCalledWith(
      'app-id',
      request,
      '/api/app/app-id/rpc',
      '',
      {
        signWithSecret: 'signing-secret',
        expectedDeploymentId: 'deployment-1',
      },
    );
  });

  it('rejects an authenticated RPC call below the compatibility minimum', async () => {
    mocks.findDeployment.mockResolvedValue({ compatibilityVersion: 0 });

    const response = await handleRpcRequest({
      request: new Request('https://hatch.test/api/app/app-id/rpc/todos.list'),
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain('cannot run');
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });
});
