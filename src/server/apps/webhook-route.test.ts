import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
  authenticate: vi.fn<() => Promise<unknown>>(),
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

vi.mock('~server/auth/credentials', () => ({
  authenticateCredential: mocks.authenticate,
}));
vi.mock('~server/session-http-auth', () => ({
  isTrustedSessionOrigin: (origin: string) => origin === 'https://hatch.test',
  sessionOriginError: (request: Request) => {
    const origin = request.headers.get('origin');
    return (origin && origin !== 'https://hatch.test') ||
      request.headers.get('sec-fetch-site') === 'cross-site'
      ? new Response('Forbidden', { status: 403 })
      : null;
  },
}));

import { handle } from '~/routes/api/app/$appId/hook/$.ts';

const headerCases = (values: Record<string, string>[]) => values;

describe('App webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-1',
      capabilities: { webhook: true, backend: true },
      webhookSecret: 'webhook-secret',
      signingSecret: 'signing-secret',
    });
    mocks.proxyAppRequest.mockResolvedValue(new Response('proxied'));
    mocks.authenticate.mockResolvedValue({ run: null });
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 2,
      manifestNormalized: { webhook: { auth: 'platform' } },
    });
  });

  it('forwards hook subpaths through the singular App API namespace', async () => {
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 2,
      manifestNormalized: { webhook: { auth: 'none' } },
    });
    const request = new Request(
      'https://hatch.test/api/app/example/hook/github/events?delivery=1',
    );

    const response = await handle({ request });

    expect(response.status).toBe(200);
    expect(mocks.proxyAppRequest).toHaveBeenCalledWith(
      'example',
      request,
      '/api/app/example/hook',
      '/__webhook',
      {
        expectedDeploymentId: 'deployment-1',
      },
    );
  });

  it('keeps platform authentication ahead of the compatibility response', async () => {
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 0,
      manifestNormalized: { webhook: { auth: 'platform' } },
    });

    const forbidden = await handle({
      request: new Request('https://hatch.test/api/app/example/hook/run'),
    });
    expect(forbidden.status).toBe(403);

    const unsupported = await handle({
      request: new Request('https://hatch.test/api/app/example/hook/run', {
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
      request: new Request('https://hatch.test/api/app/example/hook/run'),
    });

    expect(response.status).toBe(503);
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });

  it('rejects the former hooks namespace before reading App state', async () => {
    const response = await handle({
      request: new Request('https://hatch.test/api/hooks/example/run'),
    });

    expect(response.status).toBe(404);
    expect(mocks.findApp).not.toHaveBeenCalled();
    expect(mocks.findDeployment).not.toHaveBeenCalled();
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });
  it('prioritizes explicit credentials without falling back to valid secrets or Cookies', async () => {
    mocks.authenticate.mockRejectedValue(new Error('Invalid credential'));
    for (const headers of headerCases([
      { 'x-api-key': '', authorization: 'Bearer valid' },
      { authorization: 'Basic malformed' },
    ])) {
      const response = await handle({
        request: new Request(
          'https://hatch.test/api/app/example/hook?secret=webhook-secret',
          {
            headers: {
              ...headers,
              cookie: 'valid',
              origin: 'https://hatch.test',
              'x-hatch-secret': 'webhook-secret',
            } as Record<string, string>,
          },
        ),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Unauthorized');
    }
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });

  it('signs native invocations and preserves query parameters not used to authenticate', async () => {
    for (const headers of headerCases([
      { 'x-api-key': 'key' },
      { authorization: 'Bearer session-or-run' },
      { cookie: 'session', origin: 'https://hatch.test' },
      { cookie: 'session', 'sec-fetch-site': 'same-origin' },
    ])) {
      const response = await handle({
        request: new Request(
          'https://hatch.test/api/app/example/hook?delivery=1',
          { headers },
        ),
      });
      expect(response.status).toBe(200);
      expect(mocks.proxyAppRequest).toHaveBeenLastCalledWith(
        'example',
        expect.any(Request),
        '/api/app/example/hook',
        '/__webhook',
        {
          stripSecretParam: false,
          expectedDeploymentId: 'deployment-1',
          signWithSecret: 'signing-secret',
        },
      );
    }
  });

  it('selects an explicit secret before Cookie and strips only an authenticating query secret', async () => {
    for (const [url, headers, stripped] of [
      ['?secret=webhook-secret', {}, true],
      ['?secret=app-value', { 'x-hatch-secret': 'webhook-secret' }, false],
    ] as const) {
      const response = await handle({
        request: new Request(`https://hatch.test/api/app/example/hook${url}`, {
          headers,
        }),
      });
      expect(response.status).toBe(200);
      expect(mocks.proxyAppRequest).toHaveBeenLastCalledWith(
        'example',
        expect.any(Request),
        '/api/app/example/hook',
        '/__webhook',
        expect.objectContaining({ stripSecretParam: stripped }),
      );
    }
    for (const [url, headers] of [
      ['?secret=webhook-secret', { 'x-hatch-secret': '' }],
      ['?secret=wrong', { cookie: 'valid', origin: 'https://hatch.test' }],
    ] as const) {
      const response = await handle({
        request: new Request(`https://hatch.test/api/app/example/hook${url}`, {
          headers,
        }),
      });
      expect(response.status).toBe(403);
    }
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it('denies unproven or hostile Cookie origins even on GET', async () => {
    for (const headers of headerCases([
      { cookie: 'session' },
      { cookie: 'session', origin: 'https://evil.test' },
      {
        cookie: 'session',
        origin: 'https://hatch.test',
        'sec-fetch-site': 'cross-site',
      },
    ])) {
      expect(
        (
          await handle({
            request: new Request('https://hatch.test/api/app/example/hook', {
              headers,
            }),
          })
        ).status,
      ).toBe(403);
    }
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });

  it('never authenticates invalid incoming platform credentials in none mode', async () => {
    mocks.findDeployment.mockResolvedValue({
      compatibilityVersion: 2,
      manifestNormalized: { webhook: { auth: 'none' } },
    });
    const response = await handle({
      request: new Request(
        'https://hatch.test/api/app/example/hook?secret=app-value',
        {
          headers: {
            authorization: 'malformed',
            'x-api-key': 'invalid',
            cookie: 'invalid',
            origin: 'https://provider.test',
          },
        },
      ),
    });
    expect(response.status).toBe(200);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.proxyAppRequest).toHaveBeenLastCalledWith(
      'example',
      expect.any(Request),
      '/api/app/example/hook',
      '/__webhook',
      { expectedDeploymentId: 'deployment-1' },
    );
  });
});
