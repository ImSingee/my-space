/** Real Better Auth and migrated PGlite protect native transport/auth contracts. */
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { fromJson, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { AgentService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/agent_pb';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { AuthService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { WorkspaceService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/workspace_pb';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { cliClient } from '../../../packages/hatch-cli/src/client';

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
const { createHandoff, handleHandoffRequest, handleHandoffCompletion } =
  await import('../handoffs');
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
  method: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
    origin?: string;
    cookieOnly?: boolean;
  } = {},
) {
  const verb = options.method ?? 'POST';
  return handlePlatformApiRequest(
    new Request(
      `${options.origin ?? origin}/api/rpc/hatch.platform.v1.${method}`,
      {
        method: verb,
        headers: {
          ...(options.cookieOnly ? {} : { authorization: `Bearer ${token}` }),
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          ...options.headers,
        },
        body: verb === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
      },
    ),
  );
}
function client(useBinaryFormat: boolean) {
  const transport = createConnectTransport({
    baseUrl: `${origin}/api/rpc`,
    useBinaryFormat,
    interceptors: [
      (next) => (request) => {
        request.header.set('authorization', `Bearer ${token}`);
        return next(request);
      },
    ],
    fetch: (input, init) => handlePlatformApiRequest(new Request(input, init)),
  });
  return {
    agent: createClient(AgentService, transport),
    apps: createClient(AppService, transport),
    auth: createClient(AuthService, transport),
    workspace: createClient(WorkspaceService, transport),
    cli: cliClient(transport),
  };
}
async function handoff(target: 'legacy' | 'session' = 'legacy') {
  const response =
    target === 'legacy'
      ? await call('AppService/CreateAppHandoff', { body: { id: 'app-one' } })
      : await call('AuthService/CreateHandoff', {
          body: {},
        });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ticket: string;
    url: string;
    targetPath: string;
    completionUrl: string;
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
  return handleHandoffRequest(
    new Request(`${options.origin ?? origin}/api/auth/handoffs/consume`, {
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
  await db.delete(schema.dashboards);
  await db.delete(schema.workflows);
  await db.insert(schema.dashboards).values({
    id: 'dashboard-one',
    name: 'Handoff dashboard',
  });
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
  it.each([false, true])(
    'inspects historical App manifests through API and CLI binary=%s without rewriting artifacts',
    async (useBinaryFormat) => {
      const manifest = {
        id: 'app-one',
        name: 'Historical App',
        description: '',
        capabilities: {
          frontend: true,
          widgets: false,
          backend: false,
          database: false,
          cron: false,
          webhook: false,
          kv: true,
        },
        backendMode: 'serverless',
        app: { url: '/api/apps/app-one/app/' },
        widgets: [],
        cron: [],
      };
      await db
        .update(schema.deployments)
        .set({ manifestNormalized: manifest, compatibilityVersion: 1 })
        .where(eq(schema.deployments.id, 'deployment-one'));
      const api = client(useBinaryFormat);
      const detail = await api.apps.getApp({ id: 'app-one' });
      const expected = {
        compatibility: { version: 1, isSupported: true },
        manifest: {
          ...manifest,
          app: { url: '/app/example-app' },
          capabilities: {
            ...manifest.capabilities,
            storage: false,
            dataTable: false,
          },
        },
      };
      expect(toJson(ValueSchema, detail.resource!.view!)).toMatchObject(
        expected,
      );
      expect(await api.cli.apps.get({ id: 'app-one' })).toMatchObject(expected);
      const stored = await db.query.deployments.findFirst({
        where: { id: 'deployment-one' },
      });
      expect(stored!.manifestNormalized).toEqual(manifest);
    },
  );

  it.each([false, true])(
    'preserves data/inspection JSON through Connect binary=%s with native session authority',
    async (useBinaryFormat) => {
      await db
        .update(schema.apps)
        .set({
          capabilities: {
            frontend: true,
            widgets: false,
            backend: false,
            database: false,
            storage: false,
            cron: false,
            webhook: false,
            dataTable: false,
            kv: true,
          },
        })
        .where(eq(schema.apps.id, 'app-one'));
      const api = client(useBinaryFormat).apps;
      const request = (
        input: Parameters<typeof fromJson<typeof ValueSchema>>[1],
      ) => ({ id: 'app-one', input: fromJson(ValueSchema, input) });
      const first = await api.queryAppKv(
        request({
          action: 'set',
          key: 'entry',
          value: '😀'.repeat(16384),
          secret: true,
        }),
      );
      expect(toJson(ValueSchema, first.result!)).toMatchObject({
        action: 'set',
        record: { value: null, secret: true },
      });
      await api.queryAppKv(request({ action: 'set', key: 'entry', value: '' }));
      const empty = await api.queryAppKv(
        request({ action: 'get', key: 'entry', revealSecrets: true }),
      );
      expect(toJson(ValueSchema, empty.result!)).toMatchObject({
        record: { value: '', secret: true },
      });
      const cleared = await api.queryAppKv(
        request({
          action: 'set',
          key: 'entry',
          value: ' \n😀\n',
          secret: false,
        }),
      );
      expect(toJson(ValueSchema, cleared.result!)).toMatchObject({
        record: { value: ' \n😀\n', secret: false },
      });
      const detail = await api.getApp({ id: 'app-one' });
      expect(toJson(ValueSchema, detail.resource!.view!)).toMatchObject({
        id: 'app-one',
        currentVersion: 1,
        ops: { kv: { enabled: true, entryCount: 1 } },
      });
      expect(await api.associateAppSession({ id: 'app-one' })).toMatchObject({
        appId: 'app-one',
        association: 'not-applicable',
      });
      expect(
        await db.query.agentSessionApps.findMany({
          where: { appId: 'app-one' },
        }),
      ).toHaveLength(0);
      const sql = await api
        .queryAppDb({ id: 'app-one', sql: 'select private_fixture_value' })
        .catch((error) => error as ConnectError);
      expect(sql).toBeInstanceOf(ConnectError);
      expect(String(sql)).not.toContain('private_fixture_value');
      const spoofed = await call('AppService/AssociateAppSession', {
        body: { id: 'app-one', sessionId: 'spoofed-session' },
      });
      expect(spoofed.status).toBe(400);
      await expect(
        api.queryAppDataTable(
          request({
            action: 'mutate',
            operations: [
              {
                type: 'increment',
                table: 'records',
                id: 'row',
                field: 'value',
                amount: false,
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    },
  );
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
      expect((await call('AppService/ListApps', { headers })).status).toBe(200);
      for (const [path, body] of [
        ['AgentService/GetModelCatalog', {}],
        ['AgentService/ListSessions', {}],
        ['AgentService/GetSession', { id: runSession }],
        ['AgentService/CreateSession', {}],
        ['AppService/CreateAppHandoff', { id: 'app-one' }],
        ['AuthService/CreateHandoff', {}],
        ['WorkspaceService/GetWorkspace', {}],
      ] as const) {
        const response = await call(path, { headers, body });
        expect(response.status).toBe(403);
        const error = errorFromJson(
          await response.json(),
          undefined,
          new ConnectError('Invalid error'),
        );
        expect(error.code).toBe(Code.PermissionDenied);
        expect(error.findDetails(PublicErrorSchema)).toMatchObject([
          { code: 'SESSION_REQUIRED' },
        ]);
      }
    }
    const browser = await call('AgentService/ListSessions', {
      cookieOnly: true,
      headers: { cookie, origin, 'sec-fetch-site': 'same-origin' },
    });
    expect(browser.status).toBe(200);
    expect(
      (
        await call('AgentService/GetModelCatalog', {
          headers: { cookie, authorization: 'Bearer invalid' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call('AgentService/GetModelCatalog', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });

  it.each([false, true])(
    'round-trips generated clients, transcript values and optional presence (binary=%s)',
    async (binary) => {
      const api = client(binary);
      const created = await api.agent.createSession({ title: 'Typed client' });
      const messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello 👋' }],
          timestamp: 123,
        },
        null,
        false,
        0,
      ];
      await db
        .update(schema.agentSessions)
        .set({ messages })
        .where(eq(schema.agentSessions.id, created.id));
      const snapshot = (await api.agent.getSession({ id: created.id }))
        .session!;
      expect(snapshot.id).toBe(created.id);
      expect(snapshot.providerId).toBeUndefined();
      expect(snapshot.activeRun).toBeUndefined();
      expect(snapshot.runs).toEqual([]);
      expect(
        snapshot.messages.map((value) => toJson(ValueSchema, value)),
      ).toEqual(messages);
      expect(snapshot.updatedAt).toMatch(/^\d{4}-/);
      expect(snapshot.serverTime).toMatch(/^\d{4}-/);
      expect((await api.agent.listSessions({})).sessions).toMatchObject([
        { id: created.id, messageCount: 4 },
      ]);
      await db
        .insert(schema.agentSessionApps)
        .values({ sessionId: created.id, appId: 'app-one' });
      expect(
        (await api.agent.listSessions({ appId: 'app-one' })).sessions.map(
          (row) => row.id,
        ),
      ).toEqual([created.id]);
      expect(
        (await api.agent.listSessions({ appId: 'other-app' })).sessions,
      ).toEqual([]);
      const pendingAsk = {
        askId: 'ask-one',
        questions: [
          {
            id: 'question-one',
            prompt: 'Choose',
            allowMultiple: false,
            options: [{ id: 'yes', label: 'Yes' }],
          },
        ],
      };
      const pendingEnvRequest = {
        requestId: 'env-one',
        reason: 'Run app',
        variables: [{ key: 'TOKEN', description: 'App token', secret: true }],
      };
      await db.insert(schema.agentRuns).values({
        id: 'snapshot-run',
        sessionId: created.id,
        providerId: 'fixture',
        modelId: 'fixture',
        status: 'blocked',
        input: { text: 'Hello', userTurn: 0 },
        pendingAsk,
        pendingEnvRequest,
        pendingAnswer: {
          askId: 'ask-one',
          answers: [{ questionId: 'question-one', selectedOptionIds: ['yes'] }],
        },
      });
      const running = (await api.agent.getSession({ id: created.id })).session!;
      expect(running.activeRun).toMatchObject({
        id: 'snapshot-run',
        userTurn: 0,
        pendingAsk,
        answeredAskId: 'ask-one',
        pendingEnvRequest,
      });
      expect(running.runs).toMatchObject([
        { id: 'snapshot-run', userTurn: 0, status: 'blocked' },
      ]);
      expect(running.runs[0].completedAt).toBeUndefined();
      const handoff = await api.apps.createAppHandoff({ id: 'example-app' });
      expect(handoff.url).toBe(`${origin}/api/auth/handoffs/consume`);
      expect((await consume(handoff.ticket)).status).toBe(303);
    },
  );

  it('returns safe App projections, real session snapshots, and enabled model defaults', async () => {
    for (const [method, body] of [
      ['AppService/ListApps', {}],
      ['AppService/GetApp', { id: 'app-one' }],
    ] as const) {
      const response = await call(method, { body });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).toContain('Example app');
      expect(text).not.toMatch(
        /never-return|private\/repo|webhookSecret|signingSecret/,
      );
    }
    expect(
      (await call('AppService/GetApp', { body: { id: 'missing' } })).status,
    ).toBe(404);
    const created = await call('AgentService/CreateSession', {
      body: { title: 'From mobile' },
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const list = await call('AgentService/ListSessions');
    expect(await list.json()).toMatchObject({
      sessions: [{ id, title: 'From mobile' }],
    });
    const detail = await call('AgentService/GetSession', { body: { id } });
    expect(await detail.json()).toMatchObject({
      session: { id, title: 'From mobile' },
    });
    expect(
      (await call('AgentService/GetSession', { body: { id: 'missing' } }))
        .status,
    ).toBe(404);
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
    const config = await (await call('AgentService/GetModelCatalog')).json();
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
      expect((await call('AppService/ListApps', { headers })).status).toBe(401);
    const cookieOnly = await call('AppService/ListApps', {
      cookieOnly: true,
      headers: { cookie },
    });
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
      const response = await call('AgentService/CreateSession', {
        body: {},
        headers,
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(
      (
        await call('AppService/ListApps', {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(405);
  });

  it('keeps trusted instance origins and exact App IDs when creating handoffs', async () => {
    const tailscale = 'https://hatch.example.ts.net';
    const response = await call('AppService/CreateAppHandoff', {
      origin: tailscale,
      body: { id: 'app-one', targetPath: 'https://evil.example' },
      headers: { origin: tailscale },
    });
    expect(response.status).toBe(200);
    const ticket = await response.json();
    expect(ticket.url).toBe(`${tailscale}/api/auth/handoffs/consume`);
    expect(ticket.targetPath).toBe('/app/example-app/embed/');
    expect(
      (
        await consume(ticket.ticket, {
          origin: tailscale,
          headers: { origin: tailscale },
        })
      ).status,
    ).toBe(303);
    await db.insert(schema.apps).values({
      id: 'shadow',
      slug: 'app-one',
      name: 'Slug shadow',
      status: 'draft',
    });
    expect(
      (await client(true).apps.createAppHandoff({ id: 'app-one' })).targetPath,
    ).toBe('/app/example-app/embed/');
  });

  it('enforces Protovalidate fields and Connect message limits', async () => {
    expect(
      (
        await call('AgentService/CreateSession', {
          body: { title: 'x'.repeat(201) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('AgentService/CreateSession', {
          body: {},
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('AgentService/CreateSession', {
          body: { title: 'x'.repeat(20_000) },
        })
      ).status,
    ).toBe(429);
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
        await call('AppService/ListApps', {
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

describe('resource-independent session handoff', () => {
  const body = {};
  const completionPath = '/api/auth/handoffs/complete';

  it.each([false, true])(
    'uses the same session through the generated client binary=%s',
    async (useBinaryFormat) => {
      const before = await db.query.session.findMany();
      const result = await client(useBinaryFormat).auth.createHandoff({});
      expect(result.completionUrl).toBe(`${origin}${completionPath}`);
      expect(result).not.toHaveProperty('targetPath');
      expect(result.url).toBe(`${origin}/api/auth/handoffs/consume`);
      expect(Date.parse(result.expiresAt) - Date.now()).toBeLessThanOrEqual(
        60_000,
      );
      expect(JSON.stringify(result)).not.toContain(token);
      const stored = JSON.stringify(await db.query.verification.findMany());
      expect(stored).not.toContain(result.ticket);
      expect(stored).not.toContain(token);
      const response = await consume(result.ticket);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(completionPath);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const setCookie = response.headers.get('set-cookie')!;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).not.toMatch(/Domain=/i);
      const web = await auth.api.getSession({
        headers: new Headers({ cookie: cookies(response) }),
      });
      expect(web?.session.id).toBe(sessionId);
      expect((await db.query.session.findMany()).map((row) => row.id)).toEqual(
        before.map((row) => row.id),
      );
      expect((await consume(result.ticket)).status).toBe(401);
    },
  );

  it('accepts a browser session but never falls back from invalid explicit credentials', async () => {
    const browser = await call('AuthService/CreateHandoff', {
      body,
      cookieOnly: true,
      headers: { cookie, origin, 'sec-fetch-site': 'same-origin' },
    });
    expect(browser.status).toBe(200);
    for (const headers of [
      { authorization: 'Bearer invalid', cookie },
      { authorization: '', cookie },
      { 'x-api-key': 'invalid', cookie },
    ] as Record<string, string>[]) {
      expect(
        (await call('AuthService/CreateHandoff', { body, headers })).status,
      ).toBe(401);
    }
    expect(
      (await call('AuthService/CreateHandoff', { body, cookieOnly: true }))
        .status,
    ).toBe(401);
  });

  it('permits one consumer under contention and rejects expired tickets', async () => {
    const ticket = await handoff('session');
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => consume(ticket.ticket)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      303, 401, 401, 401,
    ]);
    const expired = await handoff('session');
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1) });
    expect((await consume(expired.ticket)).status).toBe(401);
  });

  it('binds issuance and consumption to the exact trusted instance origin', async () => {
    const alternate = 'https://hatch.example.ts.net';
    const attempts: { origin?: string; headers?: Record<string, string> }[] = [
      { origin: 'https://evil.example' },
      { headers: { origin: alternate } },
      { headers: { origin: 'null' } },
      { headers: { 'sec-fetch-site': 'cross-site' } },
    ];
    for (const options of attempts) {
      expect(
        (await call('AuthService/CreateHandoff', { body, ...options })).status,
      ).toBe(403);
    }
    const ticket = await handoff('session');
    expect(
      (await consume(ticket.ticket, { headers: { origin: alternate } })).status,
    ).toBe(403);
    expect((await consume(ticket.ticket, { origin: alternate })).status).toBe(
      403,
    );
    expect((await consume(ticket.ticket)).status).toBe(401);
    const native = await call('AuthService/CreateHandoff', {
      body,
      origin: alternate,
    });
    expect(native.status).toBe(200);
    const issued = (await native.json()) as { ticket: string; url: string };
    expect(issued.url).toBe(`${alternate}/api/auth/handoffs/consume`);
    expect((await consume(issued.ticket, { origin: alternate })).status).toBe(
      303,
    );
  });

  it('rejects injected redirects and invalid transport without setting a cookie', async () => {
    const { ticket } = await handoff('session');
    for (const [options, status] of [
      [{ extra: '&redirect=https://evil.example' }, 400],
      [{ extra: `&ticket=${ticket}` }, 400],
      [{ method: 'GET' }, 405],
      [{ headers: { 'content-type': 'application/json' } }, 415],
      [{ headers: { origin: 'https://evil.example' } }, 403],
    ] as const) {
      const response = await consume(ticket, options);
      expect(response.status).toBe(status);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.has('location')).toBe(false);
    }
    expect((await consume(ticket)).status).toBe(303);
  });

  it('establishes authentication without resources or after resources change', async () => {
    const pending = await handoff('session');
    await db.update(schema.apps).set({ status: 'archived' });
    await db.delete(schema.dashboards);
    expect((await consume(pending.ticket)).status).toBe(303);
    await db.delete(schema.apps);
    const issued = await handoff('session');
    const records = await db.query.verification.findMany();
    expect(JSON.parse(records[0].value)).toEqual({ sessionId, origin });
    const response = await consume(issued.ticket);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(completionPath);
    const completion = await handleHandoffCompletion(
      new Request(issued.completionUrl, {
        headers: { cookie: cookies(response) },
      }),
    );
    expect(completion.status).toBe(200);
  });

  it('only completes with a live browser cookie and never exposes credentials', async () => {
    const issued = await handoff('session');
    const consumed = await consume(issued.ticket);
    const completed = await handleHandoffCompletion(
      new Request(issued.completionUrl, {
        headers: { cookie: cookies(consumed) },
      }),
    );
    expect(completed.status).toBe(200);
    expect(completed.headers.get('cache-control')).toBe('no-store');
    expect(completed.headers.get('content-type')).toContain('text/html');
    expect(completed.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    const html = await completed.text();
    expect(html).not.toContain(token);
    expect(html).not.toContain(issued.ticket);
    for (const options of [
      {},
      { headers: { authorization: 'Bearer ' + token } },
    ]) {
      const response = await handleHandoffCompletion(
        new Request(issued.completionUrl, options),
      );
      expect(response.status).toBe(401);
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    expect(
      (
        await handleHandoffCompletion(
          new Request(issued.completionUrl, {
            method: 'POST',
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleHandoffCompletion(
          new Request(issued.completionUrl, {
            headers: { cookie, origin: 'https://evil.example' },
          }),
        )
      ).status,
    ).toBe(403);
  });

  it('caps ticket lifetime at the original session expiry and rechecks that expiry', async () => {
    const expiresAt = new Date(Date.now() + 30_000);
    await db
      .update(schema.session)
      .set({ expiresAt })
      .where(eq(schema.session.id, sessionId));
    try {
      // Better Auth refreshes sliding sessions during RPC authentication. Exercise
      // the boundary with an already-authenticated, nearly-expired snapshot.
      const ticket = await createHandoff(
        new Request(
          `${origin}/api/rpc/hatch.platform.v1.AuthService/CreateHandoff`,
        ),
        { id: sessionId, expiresAt },
      );
      expect(Date.parse(ticket.expiresAt)).toBeLessThanOrEqual(
        expiresAt.getTime(),
      );
      await db
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.session.id, sessionId));
      const response = await consume(ticket.ticket);
      expect(response.status).toBe(401);
      expect(response.headers.has('set-cookie')).toBe(false);
    } finally {
      await db
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() + 86400_000) })
        .where(eq(schema.session.id, sessionId));
    }
  });

  it('revokes both pending tickets and the browser session on native sign-out', async () => {
    const signedIn = await authCall('sign-up/email', {
      name: 'Handoff device',
      email: `${randomUUID()}@handoff.test`,
      password: 'Handoff-test-password-94',
    });
    const other = (await signedIn.json()) as { token: string };
    const headers = { authorization: `Bearer ${other.token}` };
    const issue = async () => {
      const response = await call('AuthService/CreateHandoff', {
        body,
        headers,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { ticket: string };
    };
    const first = await issue();
    const pending = await issue();
    const browser = await consume(first.ticket);
    expect(browser.status).toBe(303);
    expect((await authCall('sign-out', {}, headers)).status).toBe(200);
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: cookies(browser) }),
      }),
    ).toBeNull();
    expect((await consume(pending.ticket)).status).toBe(401);
    expect(
      (
        await handleHandoffCompletion(
          new Request(`${origin}${completionPath}`, {
            headers: { cookie: cookies(browser) },
          }),
        )
      ).status,
    ).toBe(401);
  });
});

describe('handoff contract and upgrade boundaries', () => {
  it('does not use another App deployment to authorize the target', async () => {
    const ticket = await handoff();
    await db.insert(schema.apps).values({
      id: 'other-app',
      slug: 'other-app',
      name: 'Other app',
    });
    await db
      .update(schema.deployments)
      .set({ appId: 'other-app' })
      .where(eq(schema.deployments.id, 'deployment-one'));
    const response = await consume(ticket.ticket);
    expect(response.status).toBe(409);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(
      (
        await call('AppService/CreateAppHandoff', {
          body: { id: 'app-one' },
        })
      ).status,
    ).toBe(409);
  });

  it('prunes expired handoffs without deleting other authentication records', async () => {
    const expired = new Date(Date.now() - 1);
    await db.insert(schema.verification).values([
      {
        id: 'unrelated',
        identifier: 'login',
        value: 'untouched',
        expiresAt: expired,
      },
      {
        id: 'app-handoff:old',
        identifier: 'old',
        value: '{}',
        expiresAt: expired,
      },
      { id: 'handoff:old', identifier: 'old', value: '{}', expiresAt: expired },
    ]);
    await handoff('session');
    const rows = await db.query.verification.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'unrelated')?.value).toBe('untouched');
    expect(rows.some((row) => row.id.endsWith(':old'))).toBe(false);
  });

  it('accepts an empty request and rejects resource or navigation configuration', async () => {
    for (const body of [
      { app: { id: 'app-one' } },
      { dashboard: { id: 'dashboard-one' } },
      { url: 'https://evil.example' },
      { targetPath: '//evil.example' },
      { redirect: '/settings' },
      { completionUrl: 'https://evil.example' },
    ]) {
      expect((await call('AuthService/CreateHandoff', { body })).status).toBe(
        400,
      );
    }
    expect(await db.query.verification.findMany()).toHaveLength(0);
    expect((await call('AuthService/CreateHandoff', { body: {} })).status).toBe(
      200,
    );
  });

  it.each([
    'archived',
    'frontend',
    'deployment',
    'compatibility',
    'slug',
  ] as const)(
    'rechecks App %s availability at consumption and issuance',
    async (change) => {
      const ticket = await handoff();
      if (change === 'archived')
        await db.update(schema.apps).set({ status: 'archived' });
      if (change === 'frontend')
        await db.update(schema.apps).set({ capabilities: null });
      if (change === 'deployment') await db.delete(schema.deployments);
      if (change === 'compatibility')
        await db
          .update(schema.deployments)
          .set({ compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION + 1 });
      if (change === 'slug')
        await db.update(schema.apps).set({ slug: '../outside' });
      const response = await consume(ticket.ticket);
      expect(response.status).toBe(409);
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(
        (
          await call('AppService/CreateAppHandoff', {
            body: { id: 'app-one' },
          })
        ).status,
      ).toBe(409);
    },
  );

  it('consumes pre-upgrade App tickets once through the shared validation path', async () => {
    const ticket = randomBytes(32).toString('base64url');
    await db.insert(schema.verification).values({
      id: 'app-handoff:' + createHash('sha256').update(ticket).digest('hex'),
      identifier: 'app-handoff:' + sessionId,
      value: JSON.stringify({
        sessionId,
        appId: 'app-one',
        origin,
        targetPath: '/app/example-app/embed/',
      }),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await consume(ticket);
    expect(response.status).toBe(303);
    expect(
      (
        await auth.api.getSession({
          headers: new Headers({ cookie: cookies(response) }),
        })
      )?.session.id,
    ).toBe(sessionId);
    expect((await consume(ticket)).status).toBe(401);
  });

  it.each(['legacy', 'session'] as const)(
    'fails closed for corrupt %s envelopes',
    async (kind) => {
      for (const replacement of [
        '{invalid',
        { targetPath: '//evil.example' },
        { target: { type: 'url', id: 'https://evil.example' } },
        { target: { type: 'dashboard', id: 'dashboard-one' } },
      ]) {
        const { ticket } = await handoff(kind);
        const record = (await db.query.verification.findMany())[0];
        await db.update(schema.verification).set({
          value:
            typeof replacement === 'string'
              ? replacement
              : JSON.stringify({ ...JSON.parse(record.value), ...replacement }),
        });
        const response = await consume(ticket);
        expect([403, 409]).toContain(response.status);
        expect(response.headers.has('set-cookie')).toBe(false);
        expect(response.headers.has('location')).toBe(false);
      }
    },
  );
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
        await call('AppService/CreateAppHandoff', {
          body: { id: '' },
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
    expect(
      (await call('AppService/CreateAppHandoff', { body: { id: 'app-one' } }))
        .status,
    ).toBe(409);
    await db
      .update(schema.apps)
      .set({ status: 'deployed' })
      .where(eq(schema.apps.id, 'app-one'));
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION + 1 });
    expect(
      (await call('AppService/CreateAppHandoff', { body: { id: 'app-one' } }))
        .status,
    ).toBe(409);
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
      await call('AppService/CreateAppHandoff', {
        body: { id: 'app-one' },
        headers,
      })
    ).json()) as { ticket: string };
    const pending = (await (
      await call('AppService/CreateAppHandoff', {
        body: { id: 'app-one' },
        headers,
      })
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

describe('session workspace navigation', () => {
  it.each([false, true])(
    'preserves web ordering, pin identity, names and hash entries binary=%s',
    async (useBinaryFormat) => {
      await db.delete(schema.dashboards);
      await db.insert(schema.dashboards).values([
        { id: 'last', name: 'Last', sortOrder: 5, pinned: false },
        {
          id: 'first',
          name: 'Overview',
          description: 'Daily view',
          sortOrder: 1,
          pinned: true,
          autoRefresh: 30,
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'second',
          name: 'Second',
          sortOrder: 1,
          createdAt: new Date('2026-02-01'),
        },
      ]);
      await db.insert(schema.apps).values({
        id: 'archived',
        slug: 'archived',
        name: 'Archived',
        status: 'archived',
      });
      await db.insert(schema.sidebarItems).values([
        { id: 'root', appId: 'app-one', label: '', sortOrder: 5 },
        {
          id: 'today',
          appId: 'app-one',
          label: 'Today',
          entryHash: '/today?filter=mine',
          sortOrder: 1,
          createdAt: new Date('2026-01-01'),
        },
        {
          id: 'archive',
          appId: 'app-one',
          label: 'Archive',
          entryHash: '/archive',
          sortOrder: 1,
          createdAt: new Date('2026-02-01'),
        },
        { id: 'hidden', appId: 'archived', label: 'Hidden', sortOrder: 0 },
      ]);
      await db.insert(schema.workflows).values([
        {
          id: 'older',
          slug: 'older',
          name: 'Older',
          pinned: true,
          sortOrder: 0,
          updatedAt: new Date('2026-01-01'),
        },
        {
          id: 'newer',
          slug: 'newer',
          name: 'Newer',
          pinned: true,
          sortOrder: 9,
          updatedAt: new Date('2026-02-01'),
        },
        {
          id: 'hidden',
          slug: 'hidden',
          name: 'Hidden',
          pinned: true,
          status: 'archived',
        },
        { id: 'unpinned', slug: 'unpinned', name: 'Unpinned', pinned: false },
      ]);
      const workspace = await client(useBinaryFormat).workspace.getWorkspace(
        {},
      );
      expect(workspace.dashboards.map((d) => d.id)).toEqual([
        'first',
        'second',
        'last',
      ]);
      expect(workspace.dashboards[0]).toMatchObject({
        name: 'Overview',
        description: 'Daily view',
        pinned: true,
        autoRefreshSeconds: 30,
      });
      expect(workspace.dashboards[2]).toMatchObject({
        pinned: false,
        description: '',
      });
      expect(
        workspace.appPins.map(({ id, appId, appSlug, label, entryHash }) => ({
          id,
          appId,
          appSlug,
          label,
          entryHash,
        })),
      ).toEqual([
        {
          id: 'today',
          appId: 'app-one',
          appSlug: 'example-app',
          label: 'Today',
          entryHash: '/today?filter=mine',
        },
        {
          id: 'archive',
          appId: 'app-one',
          appSlug: 'example-app',
          label: 'Archive',
          entryHash: '/archive',
        },
        {
          id: 'root',
          appId: 'app-one',
          appSlug: 'example-app',
          label: 'Example app',
          entryHash: '',
        },
      ]);
      expect(workspace.pinnedWorkflowIds).toEqual(['newer', 'older']);
      const serialized = JSON.stringify(workspace);
      expect(serialized).not.toContain('never-return');
      expect(serialized).not.toContain('/private/repo');
      const { readDashboards, readSidebarItems } =
        await import('../workspace-read');
      expect((await readDashboards()).map((d) => d.id)).toEqual(
        workspace.dashboards.map((d) => d.id),
      );
      expect(
        (await readSidebarItems())
          .filter((p) => p.status !== 'archived')
          .map((p) => p.id),
      ).toEqual(workspace.appPins.map((p) => p.id));
    },
  );

  it('uses the same default dashboard when web and native initialize an empty instance concurrently', async () => {
    await db.delete(schema.dashboards);
    await db.delete(schema.apps);
    const { readDashboards } = await import('../workspace-read');
    const [web, native, repeated] = await Promise.all([
      readDashboards(),
      client(false).workspace.getWorkspace({}),
      client(true).workspace.getWorkspace({}),
    ]);
    expect(web.map((d) => d.id)).toEqual(['default']);
    for (const value of [native, repeated]) {
      expect(value.dashboards).toMatchObject([
        { id: 'default', name: 'My Dashboard', pinned: true },
      ]);
      expect(value.appPins).toEqual([]);
      expect(value.pinnedWorkflowIds).toEqual([]);
    }
    expect(await db.query.dashboards.findMany()).toHaveLength(1);
  });

  it('requires a valid session, rejects explicit invalid credentials and cross-origin reads before initialization', async () => {
    await db.delete(schema.dashboards);
    for (const [headers, status] of [
      [{}, 401],
      [{ authorization: 'Bearer invalid', cookie }, 401],
      [{ 'x-api-key': 'invalid', cookie }, 401],
      [{ cookie, origin: 'https://evil.example' }, 403],
      [{ cookie, origin: 'null' }, 403],
      [{ cookie, 'sec-fetch-site': 'cross-site' }, 403],
    ] as const) {
      const response = await call('WorkspaceService/GetWorkspace', {
        cookieOnly: true,
        headers,
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(await db.query.dashboards.findMany()).toEqual([]);
    }
    const response = await call('WorkspaceService/GetWorkspace', {
      cookieOnly: true,
      headers: { cookie, origin, 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).dashboards).toMatchObject([
      { id: 'default' },
    ]);
  });
});
