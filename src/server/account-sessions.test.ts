import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  cookie: '',
  database: undefined as
    | Awaited<ReturnType<typeof import('~/db/test-db').createTestDb>>
    | undefined,
}));
vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  fixture.database = await createTestDb();
  return fixture.database;
});
vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => ({
    handler: (fn: unknown) => fn,
    inputValidator: (validator: { parse: (data: unknown) => unknown }) => ({
      handler:
        (fn: (input: unknown) => unknown) =>
        async ({ data }: { data: unknown }) =>
          fn({ data: validator.parse(data) }),
    }),
  }),
  createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () =>
    new Request('http://localhost:3700/settings/account', {
      headers: { cookie: fixture.cookie },
    }),
}));
vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: () => ({ id: 'test-cookie-transport' }),
}));
vi.mock('./tailscale-manager', () => ({
  getTailscaleManager: () => ({ trustedOrigin: () => null }),
}));
vi.stubEnv('SECRET', 'account-sessions-regression-test-secret-32-characters');
await import('~/db');
const { db, schema } = fixture.database!;
const { auth } = await import('~auth/server');
const { listAccountSessions, revokeAccountSession } =
  await import('./account-sessions');
const origin = 'http://localhost:3700';
const password = 'Account-regression-password-93';

async function call(path: string, body?: unknown, cookie = fixture.cookie) {
  return auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'user-agent': 'Account-session-test-browser',
        'x-forwarded-for': '192.0.2.10',
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
async function signup() {
  const email = `${randomUUID()}@account.example.test`;
  const response = await call(
    'sign-up/email',
    { name: 'Test owner', email, password },
    '',
  );
  expect(response.status).toBe(200);
  fixture.cookie = cookies(response);
  const current = await auth.api.getSession({
    headers: new Headers({ cookie: fixture.cookie }),
  });
  expect(current).not.toBeNull();
  return { email, current: current! };
}

beforeEach(async () => {
  fixture.cookie = '';
  await db.delete(schema.user);
  await db.delete(schema.deviceCode);
});
afterAll(async () => {
  await db.$client.close();
  vi.unstubAllEnvs();
});

it('revokes CLI bearer sessions without signing out the browser', async () => {
  await signup();
  const code = await call('device/code', { client_id: 'hatch-cli' });
  expect(code.status).toBe(200);
  const grant = (await code.json()) as {
    user_code: string;
    device_code: string;
  };
  expect((await call(`device?user_code=${grant.user_code}`)).status).toBe(200);
  expect(
    (await call('device/approve', { userCode: grant.user_code })).status,
  ).toBe(200);
  const token = await call('device/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: grant.device_code,
    client_id: 'hatch-cli',
  });
  expect(token.status).toBe(200);
  const cli = (await token.json()) as { access_token: string };
  const cliSession = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${cli.access_token}` }),
  });
  expect(cliSession).not.toBeNull();
  await revokeAccountSession({ data: { sessionId: cliSession!.session.id } });
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${cli.access_token}` }),
    }),
  ).toBeNull();
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: fixture.cookie }),
    }),
  ).not.toBeNull();
  expect((await call('sign-out', {})).status).toBe(200);
  expect(
    await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${cli.access_token}` }),
    }),
  ).toBeNull();
});

it('lists only active owned sessions without tokens, revokes another browser, and protects the current and foreign sessions', async () => {
  const { email, current } = await signup();
  const ownerCookie = fixture.cookie;
  const login = await call('sign-in/email', { email, password });
  const otherCookie = cookies(login);
  const other = await auth.api.getSession({
    headers: new Headers({ cookie: otherCookie }),
  });
  const { current: foreign } = await signup();
  const foreignCookie = fixture.cookie;
  fixture.cookie = ownerCookie;
  await db.insert(schema.session).values({
    id: 'expired-session',
    token: 'expired-session-token',
    userId: current.user.id,
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    expiresAt: new Date('2020-02-01'),
  });
  const active = await listAccountSessions();
  expect(active.items.map((item) => item.id)).toEqual([
    other!.session.id,
    current.session.id,
  ]);
  expect(
    active.items.filter((item) => item.isCurrent).map((item) => item.id),
  ).toEqual([current.session.id]);
  expect(JSON.stringify(active)).not.toContain(current.session.token);
  expect(JSON.stringify(active)).not.toContain(other!.session.token);
  await expect(
    revokeAccountSession({ data: { sessionId: current.session.id } }),
  ).rejects.toThrow('current session');
  expect(
    await revokeAccountSession({ data: { sessionId: foreign.session.id } }),
  ).toEqual({ success: true });
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: foreignCookie }),
    }),
  ).not.toBeNull();
  expect(
    await revokeAccountSession({ data: { sessionId: other!.session.id } }),
  ).toEqual({ success: true });
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: otherCookie }),
    }),
  ).toBeNull();
  expect(
    await auth.api.getSession({
      headers: new Headers({ cookie: ownerCookie }),
    }),
  ).not.toBeNull();
  expect((await listAccountSessions()).items.map((item) => item.id)).toEqual([
    current.session.id,
  ]);
  expect(
    await revokeAccountSession({ data: { sessionId: other!.session.id } }),
  ).toEqual({ success: true });
  expect(
    await revokeAccountSession({ data: { sessionId: 'nonexistent' } }),
  ).toEqual({ success: true });
  await expect(
    revokeAccountSession({ data: { sessionId: '' } }),
  ).rejects.toThrow('Too small');
});

it('rejects unauthenticated session management', async () => {
  const { current } = await signup();
  fixture.cookie = '';
  await expect(listAccountSessions()).rejects.toThrow('Unauthorized');
  await expect(
    revokeAccountSession({ data: { sessionId: current.session.id } }),
  ).rejects.toThrow('Unauthorized');
});
