import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
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

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
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

import { handle } from '~/routes/api/hooks/$appId/$.ts';

describe('App webhook compatibility gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-1',
      capabilities: { webhook: true },
      webhookSecret: 'webhook-secret',
      signingSecret: 'signing-secret',
    });
    mocks.proxyAppRequest.mockResolvedValue(new Response('proxied'));
  });

  it('keeps platform authentication ahead of the compatibility response', async () => {
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 0,
      manifestNormalized: { webhook: { auth: 'platform' } },
    });

    const forbidden = await handle({
      request: new Request('https://hatch.test/api/hooks/example/run'),
    });
    expect(forbidden.status).toBe(403);

    const unsupported = await handle({
      request: new Request('https://hatch.test/api/hooks/example/run', {
        headers: { 'x-hatch-secret': 'webhook-secret' },
      }),
    });
    expect(unsupported.status).toBe(503);
    await expect(unsupported.text()).resolves.toContain('cannot run');
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });

  it('blocks an unsupported self-authenticated webhook before proxying', async () => {
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 0,
      manifestNormalized: { webhook: { auth: 'none' } },
    });

    const response = await handle({
      request: new Request('https://hatch.test/api/hooks/example/run'),
    });

    expect(response.status).toBe(503);
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });
});
