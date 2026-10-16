/** Real Better Auth and migrated PGlite protect native transport/auth contracts. */
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

const fixture = vi.hoisted(() => ({
  database: undefined as
    | Awaited<ReturnType<typeof import('~/db/test-db').createTestDb>>
    | undefined,
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  fixture.database = await createTestDb();
  return fixture.database;
});
vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: () => ({ id: 'test-cookie-transport' }),
}));
vi.mock('~server/tailscale-manager', () => ({
  getTailscaleManager: () => ({
    trustedOrigin: () => 'https://hatch.example.ts.net',
  }),
}));
vi.stubEnv('SECRET', 'mobile-contract-test-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://hatch.example.test');

await import('~/db');
const { db, schema } = fixture.database!;
const { auth } = await import('~auth/server');
const { handlePlatformApiRequest } = await import('./http');
const { authenticateSessionRequest } = await import('../session-http-auth');
const origin = 'https://hatch.example.test';
let cookie = '';
let token = '';
let sessionId = '';

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function authCall(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
function call(
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
    origin?: string;
  } = {},
) {
  return handlePlatformApiRequest(
    new Request(`${options.origin ?? origin}/api/v1/${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
}
async function handoff() {
  const response = await call('apps/app-one/handoffs', { body: {} });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ticket: string;
    url: string;
    targetPath: string;
    expiresAt: string;
  };
}
function consume(
  ticket: string,
  options: {
    headers?: Record<string, string>;
    extra?: string;
    origin?: string;
    method?: string;
  } = {},
) {
  return handlePlatformApiRequest(
    new Request(`${options.origin ?? origin}/api/v1/auth/handoffs/consume`, {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...options.headers,
      },
      body:
        options.method === 'GET'
          ? undefined
          : `ticket=${encodeURIComponent(ticket)}${options.extra ?? ''}`,
    }),
  );
}

beforeAll(async () => {
  const response = await authCall('sign-up/email', {
    name: 'Mobile test',
    email: `${randomUUID()}@mobile.test`,
    password: 'Mobile-test-password-93',
  });
  if (response.status !== 200) throw new Error('Test sign-up failed');
  cookie = cookies(response);
  token = ((await response.json()) as { token: string }).token;
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  sessionId = session!.session.id;
});
beforeEach(async () => {
  await db.delete(schema.agentSessions);
  await db.delete(schema.apps);
  await db.delete(schema.agentProviders);
  await db.delete(schema.verification);
  await db.insert(schema.apps).values({
    id: 'app-one',
    slug: 'example-app',
    name: 'Example app',
    status: 'deployed',
    currentDeploymentId: 'deployment-one',
    webhookSecret: 'never-return-webhook-secret',
    signingSecret: 'never-return-signing-secret',
    repoPath: '/private/repo',
    capabilities: {
      frontend: true,
      backend: false,
      database: false,
      widgets: false,
      cron: false,
      webhook: false,
      kv: false,
    },
  });
  await db.insert(schema.deployments).values({
    id: 'deployment-one',
    appId: 'app-one',
    status: 'deployed',
    compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
  });
});
afterAll(async () => {
  await db.$client.close();
  vi.unstubAllEnvs();
});

describe('interactive Platform API contracts and authority', () => {
  it('keeps API-key and live Run authority out of user-session resources', async () => {
    const keyResponse = await authCall(
      'api-key/create',
      { name: 'Interactive boundary test' },
      { cookie },
    );
    expect(keyResponse.status).toBe(200);
    const key = ((await keyResponse.json()) as { key: string }).key;
    const runSession = randomUUID();
    const runId = randomUUID();
    const runnerId = 'interactive-test-runner';
    await db.insert(schema.agentSessions).values({ id: runSession });
    await db.insert(schema.agentRuns).values({
      id: runId,
      sessionId: runSession,
      runnerId,
      providerId: 'fixture',
      modelId: 'fixture',
      input: { text: 'fixture' },
      leaseExpiresAt: new Date(Date.now() + 90_000),
    });
    const now = Math.floor(Date.now() / 1000);
    const jwt = await auth.api.signJWT({
      body: {
        payload: {
          sub: runId,
          sid: runSession,
          rnr: runnerId,
          iat: now,
          exp: now + 90,
          jti: randomUUID(),
        },
      },
    });
    for (const headers of [
      { 'x-api-key': key, cookie },
      { authorization: `Bearer ${jwt.token}`, cookie },
    ] as Record<string, string>[]) {
      // Existing resource access remains unchanged for both real credential types.
      expect((await call('apps', { headers })).status).toBe(200);
      for (const [path, body] of [
        ['agent/models', undefined],
        ['agent/sessions', undefined],
        [`agent/sessions/${runSession}`, undefined],
        ['agent/sessions', {}],
        ['apps/app-one/handoffs', {}],
      ] as const) {
        const response = await call(path, { headers, body });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: 'SESSION_REQUIRED',
        });
      }
    }
    const browser = await handlePlatformApiRequest(
      new Request(`${origin}/api/v1/agent/sessions`, {
        headers: { cookie, origin, 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(browser.status).toBe(200);
    expect(
      (
        await call('agent/models', {
          headers: { cookie, authorization: 'Bearer invalid' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call('agent/models', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });

  it('publishes resource contracts and the exceptional ticket transport in the existing OpenAPI', async () => {
    const { generatePlatformOpenApi } = await import('./openapi');
    const spec = await generatePlatformOpenApi();
    for (const [path, method] of [
      ['/agent/models', 'get'],
      ['/agent/sessions', 'get'],
      ['/agent/sessions', 'post'],
      ['/agent/sessions/{id}', 'get'],
      ['/apps/{id}/handoffs', 'post'],
    ] as const) {
      expect(spec.paths?.[path]?.[method]?.security).toEqual([
        { sessionCookie: [] },
        { sessionBearer: [] },
      ]);
    }
    const consume = spec.paths?.['/auth/handoffs/consume']?.post;
    expect(consume?.security).toEqual([]);
    expect(consume?.responses?.['303']).toBeDefined();
    expect(JSON.stringify(spec.paths)).not.toContain('/mobile');
  });

  it('returns safe App projections, real session snapshots, and enabled model defaults', async () => {
    for (const path of ['apps', 'apps/app-one']) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).toContain('Example app');
      expect(text).not.toMatch(
        /never-return|private\/repo|webhookSecret|signingSecret/,
      );
    }
    expect((await call('apps/missing')).status).toBe(404);
    const created = await call('agent/sessions', {
      body: { title: 'From mobile' },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const list = await call('agent/sessions');
    expect(await list.json()).toMatchObject([
      { id, title: 'From mobile', messageCount: 0, appIds: [] },
    ]);
    const detail = await call(`agent/sessions/${id}`);
    expect(await detail.json()).toMatchObject({
      id,
      messages: [],
      activeRun: null,
      runs: [],
    });
    expect((await call('agent/sessions/missing')).status).toBe(404);
    await db.insert(schema.agentProviders).values([
      {
        id: 'enabled',
        name: 'Enabled',
        apiType: 'openai-responses',
        baseUrl: 'https://provider.test',
        apiKey: 'private-provider-key',
      },
      {
        id: 'disabled',
        name: 'Disabled',
        apiType: 'openai-responses',
        baseUrl: 'https://provider.test',
        apiKey: 'secret',
        enabled: false,
      },
    ]);
    await db.insert(schema.agentModels).values([
      {
        id: 'good',
        providerId: 'enabled',
        name: 'Good',
        modelId: 'model-good',
      },
      {
        id: 'off',
        providerId: 'enabled',
        name: 'Off',
        modelId: 'model-off',
        enabled: false,
      },
      {
        id: 'other',
        providerId: 'disabled',
        name: 'Other',
        modelId: 'model-other',
      },
    ]);
    const config = await (await call('agent/models')).json();
    expect(config).toMatchObject({
      providers: [{ id: 'enabled', models: [{ modelId: 'model-good' }] }],
      defaultModel: { providerId: 'enabled', modelId: 'model-good' },
    });
    expect(JSON.stringify(config)).not.toMatch(
      /apiKey|private-provider-key|baseUrl|model-off|model-other/,
    );
  });

  it('reuses public App auth without falling back from explicit invalid credentials', async () => {
    for (const headers of [
      { authorization: '', cookie },
      { authorization: 'Bearer invalid', cookie },
      { authorization: 'Basic invalid', cookie },
      { authorization: 'Bearer fake.jwt.token', cookie },
      {
        authorization: `Bearer ${token}`,
        'x-api-key': 'not-a-session',
        cookie,
      },
    ] as Record<string, string>[])
      expect((await call('apps', { headers })).status).toBe(401);
    const cookieOnly = await handlePlatformApiRequest(
      new Request(`${origin}/api/v1/apps`, { headers: { cookie } }),
    );
    expect(cookieOnly.status).toBe(200);
    // Browser Agent routes continue to support their existing Cookie session.
    expect(
      await authenticateSessionRequest(
        new Request(`${origin}/api/agent/runs`, {
          headers: { cookie, origin },
        }),
      ),
    ).not.toBeInstanceOf(Response);
    const mixed = await authenticateSessionRequest(
      new Request(`${origin}/api/agent/runs`, {
        headers: { cookie, authorization: 'Bearer invalid' },
      }),
    );
    expect(mixed).toBeInstanceOf(Response);
    expect((mixed as Response).status).toBe(401);
  });

  it('rejects cross-origin browser requests without enabling CORS', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) {
      const response = await call('agent/sessions', { body: {}, headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(
      (
        await call('apps', {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('enforces bounded JSON bodies and rejects unrequested fields', async () => {
    expect(
      (await call('agent/sessions', { body: { title: 'x', extra: true } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('agent/sessions', {
          body: {},
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('agent/sessions', {
          body: { title: 'x'.repeat(20_000) },
          headers: { 'content-length': '1' },
        })
      ).status,
    ).toBe(413);
  });

  it('authorizes hatch-mobile through the existing explicit browser device approval', async () => {
    const started = await authCall('device/code', {
      client_id: 'hatch-mobile',
    });
    expect(started.status).toBe(200);
    const grant = (await started.json()) as {
      user_code: string;
      device_code: string;
      verification_uri: string;
    };
    expect(grant.verification_uri).toBe(`${origin}/cli/authorize`);
    const review = await authCall(
      `device?user_code=${grant.user_code}`,
      undefined,
      { cookie },
    );
    expect(await review.json()).toMatchObject({
      client_id: 'hatch-mobile',
      status: 'pending',
    });
    expect(
      (
        await authCall(
          'device/approve',
          { userCode: grant.user_code },
          { cookie },
        )
      ).status,
    ).toBe(200);
    const exchanged = await authCall('device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
      client_id: 'hatch-mobile',
    });
    expect(exchanged.status).toBe(200);
    const mobileToken = ((await exchanged.json()) as { access_token: string })
      .access_token;
    expect(
      (
        await call('apps', {
          headers: { authorization: `Bearer ${mobileToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await authCall('device/code', { client_id: 'unrecognized-client' }))
        .status,
    ).toBe(400);
  });
});

describe('one-use WebView handoff', () => {
  it('accepts native form posts without relaxing opaque or cross-site origin checks', async () => {
    const ticket = await handoff();
    for (const headers of [
      { origin: 'null', 'sec-fetch-site': 'none' },
      { origin, 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'none' },
    ]) {
      expect((await consume(ticket.ticket, { headers })).status).toBe(403);
    }
    const response = await consume(ticket.ticket, {
      headers: { origin, 'sec-fetch-site': 'none' },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(ticket.targetPath);
    expect((await consume(ticket.ticket)).status).toBe(401);
  });

  it('sets a real host-only HttpOnly cookie and fixed 303 App target without exposing Bearer', async () => {
    const ticket = await handoff();
    expect(new URL(ticket.url).search).toBe('');
    expect(ticket.targetPath).toBe('/app/example-app/embed/');
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(
      60_000,
    );
    expect(JSON.stringify(ticket)).not.toContain(token);
    const rows = await db.query.verification.findMany();
    expect(JSON.stringify(rows)).not.toContain(ticket.ticket);
    expect(JSON.stringify(rows)).not.toContain(token);
    const response = await consume(ticket.ticket);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/app/example-app/embed/');
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(await response.text()).toBe('');
    const web = await auth.api.getSession({
      headers: new Headers({ cookie: cookies(response) }),
    });
    expect(web?.session.id).toBe(sessionId);
    expect((await consume(ticket.ticket)).status).toBe(401);
  });

  it('permits exactly one concurrent consumer', async () => {
    const ticket = await handoff();
    const responses = await Promise.all([
      consume(ticket.ticket),
      consume(ticket.ticket),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      303, 401,
    ]);
  });

  it('rejects expired, cross-origin, cross-instance and redirect-injected handoffs', async () => {
    const expired = await handoff();
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1) });
    expect((await consume(expired.ticket)).status).toBe(401);
    const ticket = await handoff();
    expect(
      (
        await consume(ticket.ticket, {
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await consume(ticket.ticket, {
          extra: '&redirect=https://evil.example',
        })
      ).status,
    ).toBe(400);
    expect((await consume(ticket.ticket, { method: 'GET' })).status).toBe(405);
    expect(
      (await consume(ticket.ticket, { origin: 'https://hatch.example.ts.net' }))
        .status,
    ).toBe(403);
    expect((await consume(ticket.ticket)).status).toBe(401);
    expect(
      (
        await call('apps/app-one/handoffs', {
          body: { targetPath: 'https://evil.example' },
        })
      ).status,
    ).toBe(400);
  });

  it('does not open renamed, unavailable or unsupported Apps', async () => {
    const ticket = await handoff();
    await db
      .update(schema.apps)
      .set({ slug: 'renamed' })
      .where(eq(schema.apps.id, 'app-one'));
    expect((await consume(ticket.ticket)).status).toBe(409);
    await db
      .update(schema.apps)
      .set({ slug: 'example-app', status: 'archived' })
      .where(eq(schema.apps.id, 'app-one'));
    expect((await call('apps/app-one/handoffs', { body: {} })).status).toBe(
      409,
    );
    await db
      .update(schema.apps)
      .set({ status: 'deployed' })
      .where(eq(schema.apps.id, 'app-one'));
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION + 1 });
    expect((await call('apps/app-one/handoffs', { body: {} })).status).toBe(
      409,
    );
  });

  it('invalidates browser cookies and pending tickets when the native session signs out', async () => {
    const signedIn = await authCall('sign-up/email', {
      name: 'Other device',
      email: `${randomUUID()}@mobile.test`,
      password: 'Mobile-test-password-94',
    });
    const otherToken = ((await signedIn.json()) as { token: string }).token;
    const headers = { authorization: `Bearer ${otherToken}` };
    const first = (await (
      await call('apps/app-one/handoffs', { body: {}, headers })
    ).json()) as { ticket: string };
    const pending = (await (
      await call('apps/app-one/handoffs', { body: {}, headers })
    ).json()) as { ticket: string };
    const browser = await consume(first.ticket);
    expect(browser.status).toBe(303);
    expect((await authCall('sign-out', {}, headers)).status).toBe(200);
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: cookies(browser) }),
      }),
    ).toBeNull();
    expect((await consume(pending.ticket)).status).toBe(401);
  });
});
