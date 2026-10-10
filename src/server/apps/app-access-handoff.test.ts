import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
const mocks = vi.hoisted(() => ({
  session: vi.fn<() => unknown>(),
  active: vi.fn<() => unknown>(),
}));
vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.session } },
}));
vi.mock('./tailscale-services', () => ({ activeAppService: mocks.active }));

const { db, schema } = await import('~/db');
const { startAppAccess, authorizeAppAccess, finishAppAccess, hasAppAccess } =
  await import('./app-access');
const binding = {
  appId: 'handoff-app',
  origin: 'https://notes.example.ts.net',
  revision: 'revision-1',
};
const returnPath = '/tasks?filter=open#today';
const parent = {
  id: 'handoff-parent',
  userId: 'handoff-owner',
  token: 'test-token',
  expiresAt: new Date(Date.now() + 3600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(async () => {
  vi.stubEnv('SECRET', 'app-access-handoff-test-secret-32bytes');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:3700');
  await db.delete(schema.apps);
  await db.delete(schema.user);
  await db.insert(schema.user).values({
    id: parent.userId,
    name: 'Owner',
    email: 'owner@example.test',
    emailVerified: true,
  });
  await db.insert(schema.session).values(parent);
  await db
    .insert(schema.apps)
    .values({ id: binding.appId, slug: 'notes', name: 'Notes' });
  mocks.session.mockReturnValue({ session: parent });
  mocks.active.mockReturnValue({ binding });
});
async function handoff() {
  const start = await startAppAccess(
    new Request(
      `${binding.origin}/__hatch/auth/start?return=${encodeURIComponent(returnPath)}`,
    ),
    binding,
    'https://hatch.example.ts.net',
  );
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const authorization = await authorizeAppAccess(
    new Request(start.headers.get('location')!),
    'https://hatch.example.ts.net',
  );
  const callback = authorization.headers.get('location')!;
  return {
    cookie,
    callback,
    complete: (headers: HeadersInit = { cookie }) =>
      finishAppAccess(new Request(callback, { headers }), binding),
  };
}
it('requires the originating browser, consumes a code once and revokes App access with the parent session', async () => {
  const flow = await handoff();
  expect((await flow.complete({})).status).toBe(400);
  const completed = await flow.complete();
  expect(completed.status).toBe(303);
  expect(completed.headers.get('location')).toBe(binding.origin + returnPath);
  expect(completed.headers.get('referrer-policy')).toBe('no-referrer');
  const cookie = completed.headers
    .getSetCookie()
    .find((v) => v.startsWith('__Host-hatch-app-access='))!;
  expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(cookie).not.toContain('Domain=');
  const request = new Request(binding.origin, {
    headers: { cookie: cookie.split(';')[0] },
  });
  expect(await hasAppAccess(request, binding)).toBe(true);
  expect((await flow.complete()).status).toBe(400);
  expect(
    await hasAppAccess(request, { ...binding, revision: 'revision-2' }),
  ).toBe(false);
  await db.delete(schema.session).where(eq(schema.session.id, parent.id));
  expect(await hasAppAccess(request, binding)).toBe(false);
});
it('rejects expired codes and mismatched binding identity without consuming a valid handoff', async () => {
  const flow = await handoff();
  const callback = new Request(flow.callback, {
    headers: { cookie: flow.cookie },
  });
  expect(
    (
      await finishAppAccess(callback, {
        ...binding,
        origin: 'https://other.example.ts.net',
      })
    ).status,
  ).toBe(400);
  expect(
    (await finishAppAccess(callback, { ...binding, revision: 'revision-2' }))
      .status,
  ).toBe(400);
  await db
    .update(schema.appAccessCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) });
  expect((await flow.complete()).status).toBe(400);
});
it('issues no code for an anonymous parent and redirects only to central sign-in', async () => {
  mocks.session.mockReturnValue(null);
  const flow = await handoff();
  expect(new URL(flow.callback).origin).toBe('https://hatch.example.ts.net');
  expect(new URL(flow.callback).pathname).toBe('/login');
  expect(await db.query.appAccessCodes.findMany()).toHaveLength(0);
});
