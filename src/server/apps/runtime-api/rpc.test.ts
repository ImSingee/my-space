import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
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
  db: { query: { apps: { findFirst: mocks.findApp } } },
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

  it.each([
    '/api/apps/app-id/rpc/todos.list',
    '/api/application/app-id/rpc',
    '/api/appss/app-id/rpc',
    '/api/app/app-id/rpc-method',
  ])('rejects near-miss paths: %s', async (pathname) => {
    const response = await handleRpcRequest({
      request: new Request(`https://hatch.test${pathname}`),
    });

    expect(response.status).toBe(404);
    expect(mocks.findApp).not.toHaveBeenCalled();
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });
});
