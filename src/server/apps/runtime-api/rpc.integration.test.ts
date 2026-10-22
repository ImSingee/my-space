/** Real native authentication and a sandboxed Deno Connect backend. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-web';
import { toJson, toBinary, fromBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { service, value } from '../test-fixtures/invoke-backend';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: () => ({ id: 'fixture-cookie-transport' }),
}));
vi.stubEnv('SECRET', 'backend-invoke-fixture-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://backend-invoke.test');
const root = await mkdtemp(join(tmpdir(), 'hatch-backend-invoke-'));
vi.stubEnv('HATCH_DATA_DIR', root);
const { db, schema } = (await import('~/db')) as unknown as Awaited<
  ReturnType<typeof import('~/db/test-db').createTestDb>
>;
const { auth } = await import('~auth/server');
const { handleRpcRequest } = await import('./rpc');
const { handle: webhook } = await import('~/routes/api/app/$appId/hook/$.ts');
const { stopApp, proxyAppRequest, isAppRunning } = await import('../runtime');
const { deploymentArtifactDir } = await import('~agent/paths');
const origin = 'https://backend-invoke.test';
const id = 'backend-invoke';
const deploymentId = 'backend-invoke-deployment';
const capabilities = {
  backend: true,
  webhook: true,
  database: false,
  frontend: false,
  widgets: false,
  cron: false,
  kv: false,
};
let cookie: string;
let token: string;
let userId: string;
let key: string;
let keyId: string;

type Observation = {
  headers: Record<string, string>;
  rawBase64: string;
  signatureValid: boolean;
  platformEnvPresent: boolean;
};
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });
const endpoint = `${origin}/api/app/${id}/rpc/fixture.v1.EchoService/`;
function call(
  headers: HeadersInit = {},
  body: BodyInit = '{}',
  method = 'Echo',
) {
  return handleRpcRequest({
    request: new Request(`${endpoint}${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...Object.fromEntries(new Headers(headers)),
      },
      body,
    }),
  });
}
async function runToken(overrides = {}) {
  const sessionId = randomUUID();
  const runId = randomUUID();
  await db.insert(schema.agentSessions).values({ id: sessionId });
  await db.insert(schema.agentRuns).values({
    id: runId,
    sessionId,
    runnerId: 'runner',
    providerId: 'fixture',
    modelId: 'fixture',
    input: {},
    leaseExpiresAt: new Date(Date.now() + 90_000),
  });
  const now = Math.floor(Date.now() / 1000);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: runId,
        sid: sessionId,
        rnr: 'runner',
        iat: now,
        exp: now + 90,
        ...overrides,
      },
    },
  });
  return { token, runId, sessionId };
}
beforeAll(async () => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Backend owner',
        email: `${randomUUID()}@fixture.test`,
        password: 'Backend-fixture-password-93',
      }),
    }),
  );
  if (response.status !== 200) throw new Error('Fixture signup failed');
  cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  const login = (await response.json()) as {
    token: string;
    user: { id: string };
  };
  token = login.token;
  userId = login.user.id;
  const apiKey = await auth.api.createApiKey({
    body: { userId, name: 'Backend fixture', rateLimitEnabled: false },
  });
  key = apiKey.key;
  keyId = apiKey.id;
  await db.insert(schema.apps).values({
    id,
    name: 'Backend fixture',
    slug: 'backend-fixture',
    status: 'deployed',
    currentDeploymentId: deploymentId,
    capabilities,
    signingSecret: 'app-signing-fixture',
    webhookSecret: 'hook-fixture',
  });
  await db.insert(schema.deployments).values({
    id: deploymentId,
    appId: id,
    status: 'deployed',
    compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION,
    manifestNormalized: { webhook: { auth: 'none' } },
  });
  const artifact = deploymentArtifactDir(id, deploymentId);
  await mkdir(join(artifact, 'backend'), { recursive: true });
  await writeFile(
    join(artifact, 'deployment.json'),
    JSON.stringify({ deploymentId }),
  );
  await writeFile(
    join(artifact, 'manifest.normalized.json'),
    JSON.stringify({
      backend: {
        entry: 'backend/main.mjs',
        runtime: 'deno-serve',
        format: 'bundle-v1',
        network: [],
      },
    }),
  );
  await build({
    entryPoints: ['src/server/apps/test-fixtures/invoke-backend.ts'],
    outfile: join(artifact, 'backend/main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
  });
}, 30000);
afterAll(async () => {
  stopApp(id);
  await db.$client.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('App backend shared native credential boundary', () => {
  it('calls the same real method with Cookie, Bearer, key and Run; signs bytes without credentials', async () => {
    const run = await runToken();
    const raw =
      '{ "text": "你好 🌍", "empty": null, "zero": 0, "false": false }';
    for (const credential of [
      { cookie },
      bearer(token),
      { 'x-api-key': key },
      bearer(run.token),
    ] as Record<string, string>[]) {
      const response = await call(
        {
          ...credential,
          'x-hatch-signature': 'forged',
          'x-hatch-timestamp': '0',
          'x-hatch-cron': 'forged',
          'x-hatch-routing': 'forged',
          'x-forwarded-host': 'evil.test',
          'x-forwarded-path': '/evil',
          'x-real-ip': '1.2.3.4',
          connection: 'x-hop',
          'x-hop': 'forged',
        },
        raw,
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        input: unknown;
        observed: Observation;
      };
      expect(result.input).toEqual(JSON.parse(raw));
      expect(result.observed.rawBase64).toBe(
        Buffer.from(raw).toString('base64'),
      );
      expect(result.observed.signatureValid).toBe(true);
      expect(result.observed.platformEnvPresent).toBe(false);
      for (const name of [
        'cookie',
        'authorization',
        'x-api-key',
        'x-hatch-cron',
        'x-hatch-routing',
        'x-forwarded-host',
        'x-forwarded-path',
        'x-real-ip',
        'x-hop',
      ])
        expect(result.observed.headers[name]).toBeUndefined();
    }
  }, 30000);

  it('rejects absent and invalid explicit credentials even with a real Cookie', async () => {
    for (const headers of [
      {},
      { cookie, authorization: '' },
      { cookie, authorization: 'Basic invalid' },
      { cookie, authorization: 'Bearer missing' },
      { cookie, authorization: 'Bearer a.b.c' },
      { cookie, 'x-api-key': '' },
      { cookie, 'x-api-key': 'invalid' },
      { cookie, 'x-api-key': '', ...bearer(token) },
    ] as Record<string, string>[]) {
      const response = await call(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: 'unauthenticated',
        message: 'Authentication required.',
      });
    }
    expect(
      await auth.api.getSession({ headers: new Headers({ 'x-api-key': key }) }),
    ).toBeNull();
  });

  it('checks key expiry, revocation and owner existence on every use', async () => {
    for (const change of [
      { expiresAt: new Date(Date.now() - 1000) },
      { enabled: false },
      { referenceId: 'deleted-owner' },
    ]) {
      await db
        .update(schema.apikey)
        .set(change)
        .where(eq(schema.apikey.id, keyId));
      expect((await call({ cookie, 'x-api-key': key })).status).toBe(401);
      await db
        .update(schema.apikey)
        .set({ expiresAt: null, enabled: true, referenceId: userId })
        .where(eq(schema.apikey.id, keyId));
    }
  });

  it('checks JWT signature/expiry and live Run status, binding and lease', async () => {
    const expired = await runToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    await db
      .update(schema.agentRuns)
      .set({ status: 'completed' })
      .where(eq(schema.agentRuns.id, expired.runId));
    const mismatch = await runToken({ rnr: 'another-runner' });
    for (const token of [
      expired.token,
      mismatch.token,
      `${mismatch.token.slice(0, -4)}xxxx`,
    ])
      expect((await call({ cookie, ...bearer(token) })).status).toBe(401);
    const run = await runToken();
    for (const change of [
      { status: 'completed' as const },
      { leaseExpiresAt: new Date(Date.now() - 1000) },
      { runnerId: 'other-runner' },
      { sessionId: expired.sessionId },
    ]) {
      await db
        .update(schema.agentRuns)
        .set(change)
        .where(eq(schema.agentRuns.id, run.runId));
      expect((await call({ cookie, ...bearer(run.token) })).status).toBe(401);
      await db
        .update(schema.agentRuns)
        .set({
          status: 'running',
          runnerId: 'runner',
          sessionId: run.sessionId,
          leaseExpiresAt: new Date(Date.now() + 90_000),
        })
        .where(eq(schema.agentRuns.id, run.runId));
    }
  });

  it('denies cross-origin browser calls without changing same-origin Cookie access', async () => {
    for (const headers of [
      { cookie, origin: 'https://evil.test' },
      { cookie, 'sec-fetch-site': 'cross-site' },
      { ...bearer(token), origin: 'https://evil.test' },
    ] as Record<string, string>[])
      expect((await call(headers)).status).toBe(403);
    expect((await call({ cookie, origin })).status).toBe(200);
  });

  it('retains raw binary signatures, body limits and App errors', async () => {
    const raw = Buffer.from([0, 255, 128, 0, 13, 10]);
    const response = await call(bearer(token), raw, 'Raw');
    const result = (await response.json()) as Observation;
    expect(result.rawBase64).toBe(raw.toString('base64'));
    expect(result.signatureValid).toBe(true);
    expect(
      (await call(bearer(token), Buffer.alloc(1024 * 1024 + 1), 'Raw')).status,
    ).toBe(413);
    const failure = await call(
      bearer(token),
      '{"reason":"business failure"}',
      'Fail',
    );
    expect(failure.status).toBe(400);
    expect(await failure.json()).toMatchObject({
      code: 'failed_precondition',
      message: expect.stringContaining('business failure'),
    });
  });

  it('retains Connect and gRPC-Web unary/streaming and compressed request bytes', async () => {
    for (const factory of [createConnectTransport, createGrpcWebTransport]) {
      const client = createClient(
        service,
        factory({
          baseUrl: `${origin}/api/app/${id}/rpc`,
          interceptors: [
            (next) => (request) => {
              request.header.set('authorization', `Bearer ${token}`);
              return next(request);
            },
          ],
          fetch: (input, init) =>
            handleRpcRequest({ request: new Request(input, init) }),
        }),
      );
      const output = toJson(ValueSchema, await client.echo(value({ zero: 0 })));
      expect(output).toMatchObject({
        input: { zero: 0 },
        observed: { signatureValid: true },
      });
      const items = [];
      for await (const item of client.stream(value({})))
        items.push(toJson(ValueSchema, item));
      expect(items).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    }
    const compressed = gzipSync(Buffer.from('{"compression":"保留"}'));
    const response = await call(
      {
        ...bearer(token),
        'content-encoding': 'gzip',
        'accept-encoding': 'gzip',
      },
      compressed,
    );
    const result = (await response.json()) as {
      input: unknown;
      observed: Observation;
    };
    expect(result.input).toEqual({ compression: '保留' });
    expect(result.observed.rawBase64).toBe(compressed.toString('base64'));
    expect(result.observed.signatureValid).toBe(true);
  });

  it('retains per-message compressed Connect/gRPC-Web streams and redirect boundaries', async () => {
    for (const protocol of ['connect', 'grpc-web']) {
      const message =
        protocol === 'connect'
          ? Buffer.from('{}')
          : Buffer.from(toBinary(ValueSchema, value({})));
      const frame = Buffer.alloc(5 + message.length);
      frame.writeUInt32BE(message.length, 1);
      message.copy(frame, 5);
      const headers = {
        ...bearer(token),
        'content-type':
          protocol === 'connect'
            ? 'application/connect+json'
            : 'application/grpc-web+proto',
        [protocol === 'connect'
          ? 'connect-accept-encoding'
          : 'grpc-accept-encoding']: 'gzip',
      };
      const response = await call(headers, frame, 'Stream');
      expect(response.status).toBe(200);
      expect(
        response.headers.get(
          protocol === 'connect' ? 'connect-content-encoding' : 'grpc-encoding',
        ),
      ).toBe('gzip');
      const bytes = Buffer.from(await response.arrayBuffer());
      const messages = [];
      let compressedFrames = 0;
      for (let offset = 0; offset < bytes.length;) {
        const flags = bytes[offset];
        const size = bytes.readUInt32BE(offset + 1);
        let data = bytes.subarray(offset + 5, offset + 5 + size);
        offset += size + 5;
        if (flags & 2 || flags & 128) continue;
        if (flags & 1) {
          compressedFrames++;
          data = gunzipSync(data);
        }
        messages.push(
          protocol === 'connect'
            ? JSON.parse(data.toString())
            : toJson(ValueSchema, fromBinary(ValueSchema, data)),
        );
      }
      expect(compressedFrames).toBe(2);
      expect(messages).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    }
    const redirected = await call(bearer(token), '{}', 'Redirect');
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBeNull();
  });

  it('retains webhook raw bytes and the platform shared-secret boundary', async () => {
    const raw = Buffer.from([255, 0, 128, 10]);
    const hook = (headers: Record<string, string>, query = '') =>
      webhook({
        request: new Request(`${origin}/api/app/${id}/hook/provider${query}`, {
          method: 'POST',
          headers,
          body: raw,
        }),
      });
    const provider = {
      'x-hatch-signature': 'forged',
    };
    let response = await hook(provider);
    let observation = (await response.json()) as Observation;
    expect(observation.headers['x-hatch-signature']).toBeUndefined();
    expect(observation.rawBase64).toBe(raw.toString('base64'));
    await db
      .update(schema.deployments)
      .set({ manifestNormalized: { webhook: { auth: 'platform' } } })
      .where(eq(schema.deployments.id, deploymentId));
    expect((await hook({ 'x-api-key': key, ...bearer(token) })).status).toBe(
      403,
    );
    response = await hook({ ...provider, 'x-hatch-secret': 'hook-fixture' });
    observation = (await response.json()) as Observation;
    expect(observation.signatureValid).toBe(true);
    expect(observation.headers['x-hatch-secret']).toBeUndefined();
    expect(observation.rawBase64).toBe(raw.toString('base64'));
  });

  it('rejects expired and revoked native sessions on Cookie and Bearer paths', async () => {
    const session = await db.query.session.findFirst({ where: { token } });
    if (!session) throw new Error('Fixture session is missing');
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.session.id, session.id));
    expect((await call(bearer(token))).status).toBe(401);
    expect((await call({ cookie })).status).toBe(401);
    await db.delete(schema.session).where(eq(schema.session.id, session.id));
    expect((await call(bearer(token))).status).toBe(401);
    expect((await call({ cookie })).status).toBe(401);
    await db.insert(schema.session).values(session);
  });

  it('keeps deployment gates and fences ahead of backend startup, with safe failure diagnostics', async () => {
    stopApp(id);
    for (const change of [
      { status: 'archived' as const },
      { currentDeploymentId: null },
      { capabilities: { ...capabilities, backend: false } },
    ]) {
      await db.update(schema.apps).set(change).where(eq(schema.apps.id, id));
      expect((await call(bearer(token))).status).toBe(404);
      expect(isAppRunning(id)).toBe(false);
      await db
        .update(schema.apps)
        .set({
          status: 'deployed',
          currentDeploymentId: deploymentId,
          capabilities,
        })
        .where(eq(schema.apps.id, id));
    }
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: 0 })
      .where(eq(schema.deployments.id, deploymentId));
    expect((await call(bearer(token))).status).toBe(503);
    expect(isAppRunning(id)).toBe(false);
    await db
      .update(schema.deployments)
      .set({ compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION })
      .where(eq(schema.deployments.id, deploymentId));
    await expect(
      proxyAppRequest(id, new Request(endpoint), `/api/app/${id}/rpc`, '', {
        expectedDeploymentId: 'stale-deployment',
        platformAuthenticated: true,
      }),
    ).rejects.toThrow('deployment changed');
    expect(isAppRunning(id)).toBe(false);
    await rm(join(deploymentArtifactDir(id, deploymentId), 'backend/main.mjs'));
    const failure = await call(bearer(token));
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({
      code: 'unavailable',
      message: 'App backend unavailable.',
    });
  });
});
