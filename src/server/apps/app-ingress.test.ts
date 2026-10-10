import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  active: vi.fn<() => unknown>(),
  access: vi.fn<() => Promise<boolean>>(),
  rpc: vi.fn<() => Response>(),
  mark: vi.fn<
    (request: Request, appId: string, authenticated: boolean) => void
  >(),
}));
vi.mock('../tailscale-manager', () => ({
  getTailscaleManager: () => ({
    snapshot: () => ({ services: [] }),
    trustedOrigin: () => 'https://hatch.example.ts.net',
    verifyIngress: (token: string) => token === 'private-proof',
  }),
}));
vi.mock('../../env', () => ({
  getPlatformEnv: () => ({ appUrl: 'http://127.0.0.1:3700' }),
}));
vi.mock('./tailscale-services', () => ({ activeAppService: mocks.active }));
vi.mock('./app-access', () => ({
  hasAppAccess: mocks.access,
  appLoginPage: () => new Response('login'),
  authorizeAppAccess: vi.fn<() => void>(),
  startAppAccess: vi.fn<() => void>(),
  finishAppAccess: vi.fn<() => void>(),
}));
vi.mock('./runtime-auth', () => ({ markAppRuntimeRequest: mocks.mark }));
vi.mock('./serve-app', () => ({ serveAppAppFile: vi.fn<() => void>() }));
vi.mock('./runtime-api/rpc', () => ({ handleRpcRequest: mocks.rpc }));
vi.mock('./runtime-api/data', () => ({
  handleDataRequest: vi.fn<() => void>(),
}));
vi.mock('./runtime-api/kv', () => ({ handleKvRequest: vi.fn<() => void>() }));
vi.mock('./runtime-api/widget', () => ({
  handleWidgetRequest: vi.fn<() => void>(),
}));
vi.mock('./runtime-api/hook', () => ({
  handleWebhookRequest: vi.fn<() => void>(),
}));
import { handleAppIngress } from './app-ingress';
const origin = 'https://notes.example.ts.net';
function request(path: string, overrides: HeadersInit = {}) {
  return new Request('http://127.0.0.1:3700' + path, {
    headers: {
      host: 'notes.example.ts.net',
      'x-hatch-ingress-app': 'app-a',
      'x-hatch-ingress-token': 'private-proof',
      'x-hatch-ingress-origin': origin,
      ...overrides,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.active.mockReturnValue({
    binding: { revision: 'one' },
    app: { slug: 'notes', capabilities: {} },
  });
  mocks.access.mockResolvedValue(false);
  mocks.rpc.mockReturnValue(new Response('runtime'));
});
it('never falls through to platform routes from an App host, including withdrawn hosts without proof', async () => {
  for (const path of [
    '/settings',
    '/_serverFn/anything',
    '/api/auth/get-session',
    '/api/app/app-b/rpc/Test',
    '/app/other/manage',
    '/api/app/app-a/source',
  ])
    expect((await handleAppIngress(request(path)))?.status).toBe(404);
  expect(
    (
      await handleAppIngress(
        request('/api/app/app-a/rpc/Test', {
          'x-hatch-ingress-token': 'forged',
        }),
      )
    )?.status,
  ).toBe(404);
  expect(
    (
      await handleAppIngress(
        new Request(origin + '/settings', {
          headers: { host: 'notes.example.ts.net' },
        }),
      )
    )?.status,
  ).toBe(404);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('dispatches only its own runtime request with an explicit scoped authentication result', async () => {
  const result = await handleAppIngress(
    request('/api/app/app-a/rpc/Test', {
      host: '127.0.0.1:3700',
      'x-forwarded-host': 'notes.example.ts.net',
    }),
  );
  expect(result?.status).toBe(200);
  expect(mocks.mark).toHaveBeenCalledWith(expect.any(Request), 'app-a', false);
  const forwarded = mocks.mark.mock.calls[0]![0] as unknown as Request;
  expect(new URL(forwarded.url).origin).toBe(origin);
  mocks.active.mockReturnValue(null);
  expect(
    (await handleAppIngress(request('/api/app/app-a/rpc/Test')))?.status,
  ).toBe(503);
  expect(mocks.rpc).toHaveBeenCalledOnce();
});
