import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  close: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  const testDb = await createTestDb();
  fixture.close = () => testDb.db.$client.close();
  return testDb;
});

const { db, schema } = await import('~/db');
const credentials = {
  email: 'owner@example.test',
  password: 'passkey-origin-test-password',
};

beforeEach(async () => {
  await db.delete(schema.user);
  await db.delete(schema.verification);
  vi.resetModules();
  vi.stubEnv('SECRET', 'passkey-origin-test-secret-at-least-32-chars');
  vi.stubEnv('AGENT_RUNNER_TOKEN', 'passkey-origin-test-runner');
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => fixture.close?.());

async function setup(appOrigin: string) {
  vi.stubEnv('APP_URL', appOrigin);
  const { auth } = await import('./server');
  const call = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${appOrigin}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: appOrigin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const signup = await call('/sign-up/email', {
    ...credentials,
    name: 'Owner',
  });
  expect(signup.status).toBe(200);
  const { user } = (await signup.json()) as { user: { id: string } };
  const signin = await call('/sign-in/email', credentials);
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token=');
  return { auth, call, cookie, userId: user.id };
}

test.each([
  'http://127.0.0.1:3700',
  'http://[::1]:3700',
  'https://192.0.2.10:8443',
])(
  'disables ceremonies but preserves password and credential management at %s',
  async (origin) => {
    const { auth, call, cookie, userId } = await setup(origin);

    for (const [path, body] of [
      ['/passkey/generate-register-options', undefined],
      ['/passkey/generate-authenticate-options', undefined],
      ['/passkey/verify-registration', { response: {} }],
      ['/passkey/verify-authentication', { response: {} }],
    ] as const) {
      const response = await call(path, body, cookie);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'PASSKEY_ORIGIN_UNSUPPORTED',
      });
    }

    // Anonymous requests and direct auth.api calls cannot bypass the gate.
    const anonymous = await auth.handler(
      new Request(`${origin}/api/auth/passkey/generate-authenticate-options`),
    );
    expect(anonymous.status).toBe(403);
    await expect(
      auth.api.generatePasskeyAuthenticationOptions({}),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'PASSKEY_ORIGIN_UNSUPPORTED' },
    });
    await expect(db.select().from(schema.verification)).resolves.toEqual([]);

    await db.insert(schema.passkey).values({
      id: 'existing-passkey',
      name: 'Existing key',
      userId,
      credentialID: 'existing-credential',
      publicKey: 'existing-public-key',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    const list = await call('/passkey/list-user-passkeys', undefined, cookie);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject([
      { id: 'existing-passkey' },
    ]);

    const rename = await call(
      '/passkey/update-passkey',
      { id: 'existing-passkey', name: 'Renamed key' },
      cookie,
    );
    expect(rename.status).toBe(200);
    await expect(db.query.passkey.findFirst()).resolves.toMatchObject({
      name: 'Renamed key',
    });
    const remove = await call(
      '/passkey/delete-passkey',
      { id: 'existing-passkey' },
      cookie,
    );
    expect(remove.status).toBe(200);
    await expect(db.select().from(schema.passkey)).resolves.toEqual([]);
  },
);

test.each(['http://localhost:3700', 'https://hatch.example.test:8443'])(
  'keeps registration and authentication enabled at %s',
  async (origin) => {
    const { call, cookie } = await setup(origin);
    const registration = await call(
      '/passkey/generate-register-options',
      undefined,
      cookie,
    );
    expect(registration.status).toBe(200);
    await expect(registration.json()).resolves.toMatchObject({
      challenge: expect.any(String),
      rp: { id: new URL(origin).hostname },
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
      },
    });
    const authentication = await call('/passkey/generate-authenticate-options');
    expect(authentication.status).toBe(200);
    await expect(authentication.json()).resolves.toMatchObject({
      challenge: expect.any(String),
      rpId: new URL(origin).hostname,
    });
    await expect(db.select().from(schema.verification)).resolves.toHaveLength(
      2,
    );
  },
);

test('rejects browser IP origins even when APP_URL is a domain', async () => {
  const origin = 'https://hatch.example.test';
  const { auth } = await setup(origin);
  for (const headers of [
    new Headers({ origin: 'http://127.1:3700' }),
    new Headers({ referer: 'http://[::1]:3700/login' }),
    new Headers({ origin: 'https://another.example.test' }),
  ]) {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/passkey/generate-authenticate-options`, {
        headers,
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PASSKEY_ORIGIN_UNSUPPORTED',
    });
  }
  await expect(db.select().from(schema.verification)).resolves.toEqual([]);

  // Internal proxy hops may use an IP; the browser's public origin is what
  // WebAuthn binds to, so a legitimate domain deployment must still work.
  const proxied = await auth.handler(
    new Request(
      'http://127.0.0.1:3700/api/auth/passkey/generate-authenticate-options',
      {
        headers: { origin },
      },
    ),
  );
  expect(proxied.status).toBe(200);
  await expect(proxied.json()).resolves.toMatchObject({
    rpId: 'hatch.example.test',
  });
});

test('allows older valid sessions to enroll but rejects anonymous and expired sessions', async () => {
  const { call, cookie } = await setup('http://localhost:3700');
  await db.update(schema.session).set({
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000),
  });
  const registration = await call(
    '/passkey/generate-register-options',
    undefined,
    cookie,
  );
  expect(registration.status).toBe(200);
  await expect(registration.json()).resolves.toMatchObject({
    challenge: expect.any(String),
  });

  const anonymous = await call('/passkey/generate-register-options');
  expect(anonymous.status).toBe(401);

  await db.update(schema.session).set({
    expiresAt: new Date(Date.now() - 1_000),
  });
  const expired = await call(
    '/passkey/generate-register-options',
    undefined,
    cookie,
  );
  expect(expired.status).toBe(401);
});
