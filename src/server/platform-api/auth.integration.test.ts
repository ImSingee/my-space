/** Real Better Auth + PostgreSQL + Runner HTTP/WS contracts. Never substitute mocks. */
import { rpcCall } from './test-client';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';
import { createLocalJWKSet, jwtVerify, SignJWT } from 'jose';
import { PROTOCOL_VERSION } from '~agent/protocol';

const databaseUrl = process.env.HATCH_AUTH_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3799';
const password = 'Hatch-integration-test-password-93';
const authSecret = 'hatch-cli-integration-secret-longer-than-thirty-two';
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let api: typeof import('./http').handlePlatformApiRequest;
let server: http.Server;
let websocketServer: WebSocketServer;
let socket: WebSocket;
let internalUrl: string;
let cookie: string;
let fixtureDataDir: string;
const runnerId = `cli-test-${randomUUID()}`;

type Device = {
  user_code: string;
  device_code: string;
  verification_uri: string;
};

/** A Better Auth endpoint, as the browser (Cookie) or CLI would call it. */
async function authCall<T = Record<string, unknown>>(
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  const text = await response.text();
  return {
    response,
    data: (text &&
    response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : null) as T,
  };
}
async function cli<T = Record<string, unknown>>(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  return rpcCall<T>(origin, path, headers, body, (input, init) =>
    api(new Request(input, init)),
  );
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signup(email = `${randomUUID()}@hatch-cli.test`) {
  const { response } = await authCall<{ user: { id: string } }>(
    'sign-up/email',
    { body: { name: 'Test owner', email, password } },
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function startDevice() {
  const { response, data } = await authCall<Device>('device/code', {
    body: { client_id: 'hatch-cli' },
  });
  expect(response.status).toBe(200);
  return data;
}
const poll = (grant: Device) =>
  authCall<{ access_token?: string; error?: string }>('device/token', {
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
      client_id: 'hatch-cli',
    },
  });
const review = (grant: Device, owner = cookie) =>
  authCall<{ status: string; client_id?: string }>(
    `device?user_code=${grant.user_code}`,
    { headers: { cookie: owner } },
  );
const decide = (grant: Device, decision: 'approve' | 'deny', owner = cookie) =>
  authCall<{ success?: boolean; error?: string }>(`device/${decision}`, {
    body: { userCode: grant.user_code },
    headers: { cookie: owner },
  });
async function liveRun() {
  const sessionId = randomUUID();
  const runId = randomUUID();
  await database.db.transaction(async (tx) => {
    await tx.insert(database.schema.agentSessions).values({
      id: sessionId,
      workspaceRunnerId: runnerId,
      workspaceAffinityState: 'claimed',
    });
    await tx.insert(database.schema.agentRuns).values({
      id: runId,
      sessionId,
      providerId: 'test',
      modelId: 'test',
      input: { text: 'Test run' },
      runnerId,
      leaseExpiresAt: new Date(Date.now() + 90000),
    });
  });
  return { runId, sessionId };
}
async function mint(runId: string, body: unknown, token = 'test-fleet-token') {
  const response = await fetch(
    `${internalUrl}/internal/api/runs/${runId}/token`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return {
    response,
    data: (await response.json()) as {
      token: string;
      expiresAt: string;
      context: Record<string, string>;
      error?: string;
    },
  };
}

describe.runIf(Boolean(databaseUrl))(
  'Public API authentication on real PostgreSQL',
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = databaseUrl;
      process.env.APP_URL = origin;
      process.env.SECRET = authSecret;
      process.env.BETTER_AUTH_SECRET = authSecret;
      fixtureDataDir = `/tmp/hatch-cli-integration-${randomUUID()}`;
      process.env.HATCH_DATA_DIR = fixtureDataDir;
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, { migrationsFolder: 'migrations' });
      auth = (await import('~auth/server')).auth;
      api = (await import('./http')).handlePlatformApiRequest;
      cookie = await signup();
      const { createInternalHttpHandler, runnerHubHandlers } =
        await import('~server/agent-runner/internal-server');
      const { handleRunnerSocket, listConnectedRunners } =
        await import('~server/agent-runner/hub');
      server = http.createServer(createInternalHttpHandler('test-fleet-token'));
      websocketServer = new WebSocketServer({ server });
      websocketServer.on('connection', (client) =>
        handleRunnerSocket(client, {
          betaFeatures: [],
          handlers: runnerHubHandlers,
        }),
      );
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No internal address');
      internalUrl = `http://127.0.0.1:${address.port}`;
      socket = new WebSocket(internalUrl.replace('http:', 'ws:'));
      await once(socket, 'open');
      const ready = new Promise<void>((resolve) =>
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as { type: string };
          if (message.type === 'hub.hello_ack')
            socket.send(JSON.stringify({ type: 'runner.ready' }));
          if (message.type === 'hub.ready_ack') resolve();
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'runner.hello',
          runnerId,
          protocolVersion: PROTOCOL_VERSION,
          activeRunIds: [],
          workspaceSessionIds: [],
        }),
      );
      await ready;
      if (
        !listConnectedRunners().some((runner) => runner.runnerId === runnerId)
      )
        throw new Error('Runner failed to become ready');
    }, 30000);
    afterAll(async () => {
      socket?.terminate();
      websocketServer?.close();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (fixtureDataDir)
        await rm(fixtureDataDir, { recursive: true, force: true });
    });

    it('keeps password login and ordinary credentials separate from Run and fleet identities', async () => {
      const email = `${randomUUID()}@hatch-cli.test`;
      const owner = await signup(email);
      expect(
        (await authCall('sign-out', { body: {}, headers: { cookie: owner } }))
          .response.status,
      ).toBe(200);
      const login = await authCall<{ token: string }>('sign-in/email', {
        body: { email, password },
      });
      expect(login.response.status).toBe(200);
      expect(login.response.headers.get('set-auth-jwt')).toBeNull();
      const session = await authCall<{ user: { email: string } }>(
        'get-session',
        {
          headers: bearer(login.data.token),
        },
      );
      expect(session.data.user.email).toBe(email);
      expect(session.response.headers.get('set-auth-jwt')).toBeNull();
      expect(
        (await cli('apps', bearer(login.data.token))).response.status,
      ).toBe(200);
      const run = await liveRun();
      const ordinaryAsFleet = await mint(
        run.runId,
        { runnerId },
        login.data.token,
      );
      expect(ordinaryAsFleet.response.status).toBe(401);
      expect(ordinaryAsFleet.data).toEqual({ error: 'Unauthorized' });
      const fleetAsSession = await authCall('get-session', {
        headers: bearer('test-fleet-token'),
      });
      expect(fleetAsSession.data).toBeNull();
      const fleetAsRun = await cli('apps', {
        cookie,
        ...bearer('test-fleet-token'),
      });
      expect(fleetAsRun.response.status).toBe(401);
      expect(fleetAsRun.data).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('logs a device in as an ordinary bearer session that sign-out ends', async () => {
      const grant = await startDevice();
      expect(grant.verification_uri).toBe(`${origin}/cli/authorize`);
      expect((await poll(grant)).data.error).toBe('authorization_pending');
      expect((await poll(grant)).data.error).toBe('slow_down');
      // A real device waits out its polling interval before trying again.
      await database.db
        .update(database.schema.deviceCode)
        .set({ lastPolledAt: new Date(Date.now() - 60_000) })
        .where(eq(database.schema.deviceCode.deviceCode, grant.device_code));
      const token = await deviceLoginFrom(grant);
      // Better Auth consumes the grant record on redemption.
      expect(
        await database.db.query.deviceCode.findFirst({
          where: { deviceCode: grant.device_code },
        }),
      ).toBeUndefined();
      const session = await authCall<{ user: { email: string } }>(
        'get-session',
        {
          headers: bearer(token),
        },
      );
      expect(session.data?.user.email).toMatch(/@hatch-cli\.test$/);
      expect((await cli('apps', bearer(token))).response.status).toBe(200);
      expect(
        (await authCall('sign-out', { body: {}, headers: bearer(token) }))
          .response.status,
      ).toBe(200);
      expect((await cli('apps', bearer(token))).response.status).toBe(401);
    });

    it('denies, and keeps another account from deciding a claimed request', async () => {
      const denied = await startDevice();
      await review(denied);
      expect((await decide(denied, 'deny')).data.success).toBe(true);
      expect((await poll(denied)).data.error).toBe('access_denied');
      expect(
        await database.db.query.deviceCode.findFirst({
          where: { deviceCode: denied.device_code },
        }),
      ).toBeUndefined();
      const claimed = await startDevice();
      expect((await review(claimed)).data.client_id).toBe('hatch-cli');
      const other = await signup();
      expect((await review(claimed, other)).data.client_id).toBeUndefined();
      const stolen = await decide(claimed, 'approve', other);
      expect(stolen.response.status).toBe(403);
      expect(stolen.data.error).toBe('access_denied');
      expect((await poll(claimed)).data.error).toBe('authorization_pending');
      expect(
        (
          await authCall('device/code', {
            body: { client_id: 'another-client' },
          })
        ).response.status,
      ).toBe(400);
    });

    it('requires a session or Run token and resolves exact IDs before slugs', async () => {
      expect((await cli('apps', {})).response.status).toBe(401);
      const invalid = await cli('apps', { cookie, ...bearer('a.b.c') });
      expect(invalid.response.status).toBe(401);
      expect(invalid.data).toMatchObject({ code: 'INVALID_TOKEN' });
      const legacyId = `legacy-${randomUUID()}`;
      // The slug holder is stored first, where an unordered match finds it.
      await database.db.insert(database.schema.apps).values([
        { id: randomUUID(), slug: legacyId, name: 'Slug holder' },
        { id: legacyId, slug: `renamed-${randomUUID()}`, name: 'Legacy' },
      ]);
      const found = await cli<{ id: string }>(`apps/${legacyId}`, { cookie });
      expect(found.data.id).toBe(legacyId);
      for (const route of ['users', 'secrets', `apps/${legacyId}/query-db`])
        expect((await cli(route, { cookie }, {})).response.status).toBe(404);
    });

    it('mints stateless five-minute Run tokens that end with the Run', async () => {
      const run = await liveRun();
      expect(
        (await mint(run.runId, { runnerId }, 'wrong-fleet-token')).response
          .status,
      ).toBe(401);
      const disconnected = await mint(run.runId, { runnerId: 'other-runner' });
      expect(disconnected.response.status).toBe(403);
      expect(disconnected.data).toEqual({ error: 'runner_not_connected' });
      for (const invalid of [{}, { runnerId, extra: true }])
        expect((await mint(run.runId, invalid)).response.status).toBe(400);
      const before = await database.db.$count(database.schema.session);
      const minted = await mint(run.runId, { runnerId });
      expect(minted.response.status).toBe(200);
      expect(minted.data.token.split('.')).toHaveLength(3);
      expect(minted.data.context).toEqual({ ...run, runnerId });
      const lifetime = Date.parse(minted.data.expiresAt) - Date.now();
      expect(lifetime).toBeGreaterThan(290_000);
      expect(lifetime).toBeLessThanOrEqual(300_000);
      // Stateless per credential: minting stores no user session.
      expect(await database.db.$count(database.schema.session)).toBe(before);
      expect(
        (await cli('apps', bearer(minted.data.token))).response.status,
      ).toBe(200);
      // Run JWTs cannot manage credentials; user API keys cannot impersonate
      // the trusted Runner fleet on its separate internal authentication entry.
      expect(
        (await authCall('api-key/list', { headers: bearer(minted.data.token) }))
          .response.status,
      ).toBe(401);
      const owner = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      const key = await auth.api.createApiKey({
        body: { userId: owner!.user.id, name: 'Fleet boundary fixture' },
      });
      expect(
        (await mint(run.runId, { runnerId }, key.key)).response.status,
      ).toBe(401);
      const tampered = `${minted.data.token.slice(0, -2)}xx`;
      expect((await cli('apps', bearer(tampered))).response.status).toBe(401);
      const renewed = await mint(run.runId, { runnerId });
      expect(renewed.data.token).not.toBe(minted.data.token);

      await database.db
        .update(database.schema.agentRuns)
        .set({ status: 'cancelled' })
        .where(eq(database.schema.agentRuns.id, run.runId));
      expect(
        (await cli('apps', bearer(renewed.data.token))).response.status,
      ).toBe(401);
      const ended = await mint(run.runId, { runnerId });
      expect(ended.response.status).toBe(401);
      expect(ended.data).toEqual({ error: 'run_ended' });

      const lapsed = await liveRun();
      const lapsedToken = (await mint(lapsed.runId, { runnerId })).data.token;
      await database.db
        .update(database.schema.agentRuns)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.agentRuns.id, lapsed.runId));
      expect((await cli('apps', bearer(lapsedToken))).response.status).toBe(
        401,
      );
    });

    it('preserves JWT verification and rejects invalid credentials before session fallback', async () => {
      const run = await liveRun();
      const minted = await mint(run.runId, { runnerId });
      const jwks = await auth.api.getJwks();
      const { payload, protectedHeader } = await jwtVerify(
        minted.data.token,
        createLocalJWKSet(jwks),
        { issuer: origin, audience: 'hatch-run' },
      );
      expect(protectedHeader.kid).toEqual(expect.any(String));
      expect(protectedHeader.alg).toBe('EdDSA');
      expect(payload).toMatchObject({
        sub: run.runId,
        sid: run.sessionId,
        rnr: runnerId,
        exp: Math.floor(Date.parse(minted.data.expiresAt) / 1000),
        iat: expect.any(Number),
        jti: expect.any(String),
      });

      const now = Math.floor(Date.now() / 1000);
      for (const overrides of [
        { exp: now - 1 },
        { iss: 'https://another-platform.test' },
        { aud: 'another-audience' },
        { sid: '' },
        { sid: undefined, rnr: undefined },
        { iat: undefined },
      ]) {
        const { token } = await auth.api.signJWT({
          body: { payload: { ...payload, ...overrides } },
        });
        const rejected = await cli('apps', { cookie, ...bearer(token) });
        expect(rejected.response.status).toBe(401);
        expect(rejected.data).toMatchObject({ code: 'INVALID_TOKEN' });
      }
      const forged = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new Uint8Array(32));
      const rejected = await cli('apps', { cookie, ...bearer(forged) });
      expect(rejected.response.status).toBe(401);
      expect(rejected.data).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('keeps Run JWT issuance server-only and out of ordinary sessions', async () => {
      for (const path of ['token', 'jwks']) {
        const { response } = await authCall(path, { headers: { cookie } });
        expect(response.status).toBe(404);
      }
      for (const path of ['sign-jwt', 'verify-jwt']) {
        const { response } = await authCall(path, {
          headers: { cookie },
          body: { payload: { sub: 'forged-run' } },
        });
        expect(response.status).toBe(404);
      }
      const session = await authCall('get-session', { headers: { cookie } });
      expect(session.response.status).toBe(200);
      expect(session.response.headers.get('set-auth-jwt')).toBeNull();
      const run = await liveRun();
      const token = (await mint(run.runId, { runnerId })).data.token;
      expect(
        (await authCall('get-session', { headers: bearer(token) })).data,
      ).toBeNull();
      // A Run token is not a fleet credential and cannot issue another token.
      expect((await mint(run.runId, { runnerId }, token)).response.status).toBe(
        401,
      );
    });

    it('keeps credentials usable across Better Auth signing-key rotation without storing Run sessions', async () => {
      const run = await liveRun();
      const sessionsBefore = await database.db.$count(database.schema.session);
      const first = (await mint(run.runId, { runnerId })).data.token;
      const { protectedHeader: firstHeader } = await jwtVerify(
        first,
        createLocalJWKSet(await auth.api.getJwks()),
      );
      const signingKey = await database.db.query.jwks.findFirst({
        where: { id: firstHeader.kid! },
      });
      expect(signingKey).toBeDefined();
      // Better Auth stores an encrypted JSON string, not private JWK material.
      expect(typeof JSON.parse(signingKey!.privateKey)).toBe('string');
      await database.db
        .update(database.schema.jwks)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.jwks.id, signingKey!.id));
      const second = (await mint(run.runId, { runnerId })).data.token;
      const { protectedHeader: secondHeader } = await jwtVerify(
        second,
        createLocalJWKSet(await auth.api.getJwks()),
      );
      expect(secondHeader.kid).not.toBe(firstHeader.kid);
      for (const token of [first, second])
        expect((await cli('apps', bearer(token))).response.status).toBe(200);
      expect(await database.db.$count(database.schema.session)).toBe(
        sessionsBefore,
      );
    });

    it('rechecks live session, Runner ownership and lease on every token use', async () => {
      const run = await liveRun();
      const other = await liveRun();
      await database.db
        .update(database.schema.agentRuns)
        .set({ status: 'completed' })
        .where(eq(database.schema.agentRuns.id, other.runId));
      const token = (await mint(run.runId, { runnerId })).data.token;
      await database.db
        .update(database.schema.agentRuns)
        .set({ status: 'blocked' })
        .where(eq(database.schema.agentRuns.id, run.runId));
      expect((await cli('apps', bearer(token))).response.status).toBe(200);

      for (const changes of [
        { sessionId: other.sessionId },
        { runnerId: 'another-runner' },
        { leaseExpiresAt: null },
        { status: 'completed' as const },
      ]) {
        await database.db
          .update(database.schema.agentRuns)
          .set(changes)
          .where(eq(database.schema.agentRuns.id, run.runId));
        const rejected = await cli('apps', { cookie, ...bearer(token) });
        expect(rejected.response.status).toBe(401);
        expect(rejected.data).toMatchObject({ code: 'RUN_ENDED' });
        const mintResult = await mint(run.runId, { runnerId });
        // A new credential binds to the Run's current session.
        expect(mintResult.response.status).toBe(
          'sessionId' in changes ? 200 : 401,
        );
        expect(mintResult.data).toMatchObject(
          'sessionId' in changes
            ? { context: { sessionId: other.sessionId } }
            : { error: 'run_ended' },
        );
        await database.db
          .update(database.schema.agentRuns)
          .set({
            sessionId: run.sessionId,
            runnerId,
            leaseExpiresAt: new Date(Date.now() + 90000),
            status: 'running',
          })
          .where(eq(database.schema.agentRuns.id, run.runId));
      }
      await database.db
        .delete(database.schema.agentRuns)
        .where(eq(database.schema.agentRuns.id, run.runId));
      const missing = await mint(run.runId, { runnerId });
      expect(missing.response.status).toBe(401);
      expect(missing.data).toEqual({ error: 'run_ended' });
      const rejected = await cli('apps', bearer(token));
      expect(rejected.response.status).toBe(401);
      expect(rejected.data).toMatchObject({ code: 'RUN_ENDED' });
    });
  },
);

/** Approve in the browser, then redeem: the token is an ordinary session token. */
async function deviceLoginFrom(grant: Device) {
  expect((await review(grant)).data.client_id).toBe('hatch-cli');
  expect((await decide(grant, 'approve')).data.success).toBe(true);
  const { response, data } = await poll(grant);
  expect(response.status).toBe(200);
  return data.access_token!;
}
