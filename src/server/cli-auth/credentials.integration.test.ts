/** Real Better Auth + PostgreSQL + Runner HTTP/WS contracts. Never substitute mocks. */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer } from 'ws';
import type { CliScope, ResourceRange } from '~auth/cli-policy';

const databaseUrl = process.env.HATCH_AUTH_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3799';
const password = 'Hatch-integration-test-password-93';
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let api: typeof import('./http').handleCliAuthRequest;
let credentials: typeof import('./credentials');
let server: http.Server;
let websocketServer: WebSocketServer;
let socket: WebSocket;
let internalUrl: string;
let cookie: string;
let userId: string;
let appA: string;
let appB: string;
const runnerId = `auth-test-${randomUUID()}`;

type Key = {
  id: string;
  token: string;
  credentialType: string;
  expiresAt: string;
};
type Device = {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
};
async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await api(
    new Request(`${origin}/api/cli/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const data = (await response.json()) as T;
  return { response, data };
}
const bearer = (key: Key) => ({ authorization: `Bearer ${key.token}` });
async function signup() {
  const email = `${randomUUID()}@hatch-auth.test`;
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test owner', email, password }),
    }),
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as { user: { id: string } };
  return {
    userId: data.user.id,
    email,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
async function newKey(
  scopes: CliScope[] = ['app.read'],
  resources: ResourceRange = { mode: 'all' },
  ownerCookie = cookie,
) {
  const result = await call<Key>(
    'auth/keys',
    { name: 'Test key', expiresIn: 3600, scopes, resources },
    { cookie: ownerCookie },
  );
  expect(result.response.status).toBe(200);
  return result.data;
}
async function device() {
  const result = await call<Device>('auth/device', {
    client_id: 'hatch-cli',
    scopes: ['app.read'],
    resources: { mode: 'all' },
  });
  expect(result.response.status).toBe(200);
  return result.data;
}
async function poll(grant: Device) {
  return call<Key & { error?: string; interval?: number }>(
    'auth/device/token',
    { client_id: 'hatch-cli', device_code: grant.device_code },
  );
}
async function approve(grant: Device, ownerCookie = cookie) {
  expect(
    (
      await call(
        'auth/device/claim',
        { user_code: grant.user_code },
        { cookie: ownerCookie },
      )
    ).response.status,
  ).toBe(200);
  expect(
    (
      await call(
        'auth/device/approve',
        { user_code: grant.user_code },
        { cookie: ownerCookie },
      )
    ).response.status,
  ).toBe(200);
}
async function assignedRun(owner = userId) {
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
      startedByUserId: owner,
      leaseExpiresAt: new Date(Date.now() + 90000),
    });
  });
  return { runId, sessionId };
}
async function internal(
  runId: string,
  body: unknown,
  token = 'test-fleet-token',
  renew = false,
) {
  const response = await fetch(
    `${internalUrl}/internal/api/cli/runs/${runId}/credential${renew ? '/renew' : ''}`,
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
    data: (await response.json()) as Key & { error?: string },
  };
}

describe.runIf(Boolean(databaseUrl))(
  'Hatch credential authorization on real PostgreSQL',
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = databaseUrl;
      process.env.APP_URL = origin;
      process.env.SECRET =
        'hatch-auth-integration-secret-longer-than-thirty-two';
      process.env.HATCH_DATA_DIR = `/tmp/hatch-auth-integration-${randomUUID()}`;
      database = await import('~/db');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(database.db, { migrationsFolder: 'migrations' });
      await migrate(database.db, { migrationsFolder: 'migrations' });
      auth = (await import('~auth/server')).auth;
      api = (await import('./http')).handleCliAuthRequest;
      credentials = await import('./credentials');
      const owner = await signup();
      cookie = owner.cookie;
      userId = owner.userId;
      appA = randomUUID();
      appB = randomUUID();
      await database.db.insert(database.schema.apps).values([
        { id: appA, slug: `test-${appA}`, name: 'Allowed' },
        { id: appB, slug: `test-${appB}`, name: 'Denied' },
      ]);
      const { createInternalHttpHandler } =
        await import('~server/agent-runner/internal-server');
      const { handleRunnerSocket, listConnectedRunners } =
        await import('~server/agent-runner/hub');
      server = http.createServer(createInternalHttpHandler('test-fleet-token'));
      websocketServer = new WebSocketServer({ server });
      websocketServer.on('connection', (client) =>
        handleRunnerSocket(client, { betaFeatures: [] }),
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
          protocolVersion: 18,
          activeRunIds: [],
          workspaceSessionIds: [],
        }),
      );
      await ready;
      if (
        !listConnectedRunners().some((runner) => runner.runnerId === runnerId)
      )
        throw new Error('Protocol-18 Runner failed to become ready');
    }, 30000);
    afterAll(async () => {
      socket?.terminate();
      websocketServer?.close();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('issues hashed named keys once and never maps keys into UI Cookie authority', async () => {
      const key = await newKey();
      const stored = await database.db.query.apikey.findFirst({
        where: { id: key.id },
      });
      expect(stored?.key === key.token).toBe(false);
      expect(stored?.key.length).toBe(43);
      const listed = await call<Record<string, unknown>[]>(
        'auth/keys',
        undefined,
        { cookie },
      );
      expect(listed.response.status).toBe(200);
      expect(listed.data.some((item) => item.id === key.id)).toBe(true);
      expect(JSON.stringify(listed.data).includes(key.token)).toBe(false);
      const status = await call('auth/status', undefined, bearer(key));
      expect(status.response.status).toBe(200);
      expect(status.data.credentialType).toBe('user_api_key');
      expect(
        (await call('auth/keys', undefined, bearer(key))).response.status,
      ).toBe(401);
      expect(
        (
          await call(
            'auth/keys',
            {
              name: 'Escalate',
              expiresIn: 3600,
              scopes: ['app.deploy'],
              resources: { mode: 'all' },
            },
            bearer(key),
          )
        ).response.status,
      ).toBe(401);
      const ui = await auth.api.getSession({
        headers: new Headers(bearer(key)),
      });
      expect(Boolean(ui)).toBe(false);
      const pluginCreate = await auth.handler(
        new Request(`${origin}/api/auth/api-key/create`, {
          method: 'POST',
          headers: { origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Bypass' }),
        }),
      );
      expect(pluginCreate.status).toBe(404);
    });

    it('enforces scopes, immutable resource IDs and default exclusions on real lifecycle API', async () => {
      const key = await newKey(['app.read'], {
        mode: 'ids',
        apps: [appA],
        workflows: [],
      });
      const list = await call<{ id: string }[]>('apps', undefined, bearer(key));
      expect(list.response.status).toBe(200);
      expect(list.data.map((row) => row.id)).toEqual([appA]);
      expect(
        (await call(`apps/${appA}`, undefined, bearer(key))).response.status,
      ).toBe(200);
      expect(
        (await call(`apps/test-${appA}`, undefined, bearer(key))).response
          .status,
      ).toBe(200);
      expect(
        (await call(`apps/${appB}`, undefined, bearer(key))).response.status,
      ).toBe(403);
      expect(
        (await call(`apps/${appA}/source`, undefined, bearer(key))).response
          .status,
      ).toBe(403);
      expect(
        (await call(`apps/${appA}/rollback`, { version: 1 }, bearer(key)))
          .response.status,
      ).toBe(403);
      expect(
        (await database.db.query.apps.findFirst({ where: { id: appA } }))
          ?.currentDeploymentId,
      ).toBeNull();
      for (const route of [
        'users',
        'providers',
        'secrets',
        `apps/${appA}/query-db`,
        `apps/${appA}/query-kv`,
        'agent-sessions',
      ])
        expect((await call(route, {}, bearer(key))).response.status).toBe(404);
      const forbiddenCreate = await call(
        'auth/keys',
        {
          name: 'Wrong',
          expiresIn: 300,
          scopes: ['app.create'],
          resources: { mode: 'ids', apps: [appA], workflows: [] },
        },
        { cookie },
      );
      expect(forbiddenCreate.response.status).toBe(400);
      const creator = await newKey(['app.create']);
      const created = await call<{ id: string }>(
        'apps',
        {
          slug: `created-${randomUUID()}`,
          name: 'Scoped creation',
          pin: false,
        },
        bearer(creator),
      );
      expect(created.response.status).toBe(200);
      expect(
        Boolean(
          await database.db.query.apps.findFirst({
            where: { id: created.data.id },
          }),
        ),
      ).toBe(true);
    });

    it('keeps Workflow lifecycle authority separate from execution data and webhook secrets', async () => {
      const creator = await newKey(['workflow.create']);
      const created = await call<{ id: string }>(
        'workflows',
        {
          slug: `workflow-${randomUUID()}`,
          name: 'Scoped workflow',
          pin: false,
        },
        bearer(creator),
      );
      expect(created.response.status).toBe(200);
      const id = created.data.id;
      await database.db
        .update(database.schema.workflows)
        .set({ webhookSecret: 'private-webhook-fixture' })
        .where(eq(database.schema.workflows.id, id));
      const reader = await newKey(['workflow.read', 'workflow.source.read'], {
        mode: 'ids',
        apps: [],
        workflows: [id],
      });
      const listing = await call<{ id: string }[]>(
        'workflows',
        undefined,
        bearer(reader),
      );
      expect(listing.data.map((row) => row.id)).toEqual([id]);
      const metadata = await call(`workflows/${id}`, undefined, bearer(reader));
      expect(metadata.response.status).toBe(200);
      expect(
        JSON.stringify(metadata.data).includes('private-webhook-fixture'),
      ).toBe(false);
      expect(
        (await call(`workflows/${id}/source`, undefined, bearer(reader)))
          .response.status,
      ).toBe(200);
      expect(
        (await call(`workflows/${id}/deploy`, {}, bearer(reader))).response
          .status,
      ).toBe(403);
      expect(
        (await call(`workflows/${id}/rollback`, { version: 1 }, bearer(reader)))
          .response.status,
      ).toBe(403);
      for (const action of ['run', 'runs', 'webhook', 'update'])
        expect(
          (await call(`workflows/${id}/${action}`, {}, bearer(reader))).response
            .status,
        ).toBe(404);
      expect(
        (await database.db.query.workflows.findFirst({ where: { id } }))
          ?.currentDeploymentId,
      ).toBeNull();
      expect(
        (await call(`apps/${appA}`, undefined, bearer(reader))).response.status,
      ).toBe(403);
    });

    it('atomically rotates, revokes and expires credentials', async () => {
      const key = await newKey();
      const results = await Promise.all([
        call<Key>(`auth/keys/${key.id}/rotate`, { expiresIn: 300 }, { cookie }),
        call<Key>(`auth/keys/${key.id}/rotate`, { expiresIn: 300 }, { cookie }),
      ]);
      expect(results.map((result) => result.response.status).sort()).toEqual([
        200, 409,
      ]);
      const active = results.find(
        (result) => result.response.status === 200,
      )!.data;
      expect(
        (await call('auth/status', undefined, bearer(key))).response.status,
      ).toBe(401);
      expect(
        (await call('auth/status', undefined, bearer(active))).response.status,
      ).toBe(200);
      expect(
        (await call(`auth/keys/${active.id}/revoke`, {}, { cookie })).response
          .status,
      ).toBe(200);
      expect(
        (await call('auth/status', undefined, bearer(active))).response.status,
      ).toBe(401);
      const expired = await newKey();
      await database.db
        .update(database.schema.apikey)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.apikey.id, expired.id));
      expect(
        (await call('auth/status', undefined, bearer(expired))).response.status,
      ).toBe(401);
    });

    it('requires expiration, a name, JSON and real same-origin Cookie on management', async () => {
      for (const body of [
        { name: 'No expiry', scopes: ['app.read'] },
        { expiresIn: 3600, scopes: ['app.read'] },
        { name: 'Bad scope', expiresIn: 3600, scopes: ['secrets.read'] },
        { name: 'Too long', expiresIn: 100 * 86400, scopes: ['app.read'] },
      ])
        expect(
          (await call('auth/keys', body, { cookie })).response.status,
        ).toBe(400);
      expect(
        (
          await call(
            'auth/keys',
            { name: 'CSRF' },
            { cookie, origin: 'https://evil.test' },
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await call('auth/device', {
            client_id: 'hatch-cli',
            user_id: userId,
            scopes: ['app.read'],
          })
        ).response.status,
      ).toBe(400);
      expect(
        (await call('auth/device/claim', { user_code: 'ANYCODE' })).response
          .status,
      ).toBe(401);
    });

    it('supports pending and persistent slow_down without granting access', async () => {
      const grant = await device();
      expect(grant.interval).toBe(5);
      expect(grant.verification_uri).toBe(`${origin}/cli/authorize`);
      expect((await poll(grant)).data.error).toBe('authorization_pending');
      const slowed = await poll(grant);
      expect(slowed.data.error).toBe('slow_down');
      expect(slowed.data.interval).toBe(10);
      const row = await database.db.query.deviceCode.findFirst({
        where: { deviceCode: grant.device_code },
      });
      expect(row?.pollingInterval).toBe(10000);
    });

    it('binds claims to a real Cookie session, including another session of the same account', async () => {
      const grant = await device();
      expect(
        (
          await call(
            'auth/device/claim',
            { user_code: grant.user_code },
            { cookie },
          )
        ).response.status,
      ).toBe(200);
      const other = await signup();
      expect(
        (
          await call(
            'auth/device/claim',
            { user_code: grant.user_code },
            { cookie: other.cookie },
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await call(
            'auth/device/approve',
            { user_code: grant.user_code },
            { cookie: other.cookie },
          )
        ).response.status,
      ).toBe(403);
      const originalUser = await database.db.query.user.findFirst({
        where: { id: userId },
      });
      const signIn = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ email: originalUser!.email, password }),
        }),
      );
      const differentSession = signIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect(
        (
          await call(
            'auth/device/approve',
            { user_code: grant.user_code },
            { cookie: differentSession },
          )
        ).response.status,
      ).toBe(403);
    });

    it('serializes approve/deny and consumes each approved device grant at most once', async () => {
      const grant = await device();
      await call(
        'auth/device/claim',
        { user_code: grant.user_code },
        { cookie },
      );
      const decisions = await Promise.all([
        call('auth/device/approve', { user_code: grant.user_code }, { cookie }),
        call('auth/device/deny', { user_code: grant.user_code }, { cookie }),
      ]);
      expect(decisions.map((item) => item.response.status).sort()).toEqual([
        200, 409,
      ]);
      const decided = await database.db.query.deviceCode.findFirst({
        where: { deviceCode: grant.device_code },
      });
      expect(['approved', 'denied'].includes(decided!.status)).toBe(true);
      const approved = await device();
      await approve(approved);
      const exchanges = await Promise.all([poll(approved), poll(approved)]);
      expect(exchanges.map((item) => item.response.status).sort()).toEqual([
        200, 400,
      ]);
      const issued = exchanges.find(
        (item) => item.response.status === 200,
      )!.data;
      expect(issued.credentialType).toBe('interactive_key');
      expect(
        (await call('auth/status', undefined, bearer(issued))).response.status,
      ).toBe(200);
      expect((await poll(approved)).data.error).toBe('invalid_grant');
      const cookieCount = await database.db.query.session.findMany({
        where: { userId },
      });
      expect(cookieCount.length).toBe(2); // signup + explicit sign-in, never device redemption
    });

    it('rejects denied, cancelled and expired grants, and cancellation races safely with exchange', async () => {
      const denied = await device();
      await call(
        'auth/device/claim',
        { user_code: denied.user_code },
        { cookie },
      );
      await call(
        'auth/device/deny',
        { user_code: denied.user_code },
        { cookie },
      );
      expect((await poll(denied)).data.error).toBe('access_denied');
      const expired = await device();
      await database.db
        .update(database.schema.deviceCode)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.deviceCode.deviceCode, expired.device_code));
      expect((await poll(expired)).data.error).toBe('expired_token');
      const cancelled = await device();
      await approve(cancelled);
      const raced = await Promise.all([
        call('auth/device/cancel', {
          client_id: 'hatch-cli',
          device_code: cancelled.device_code,
        }),
        poll(cancelled),
      ]);
      expect(raced.filter((item) => item.response.status === 200).length).toBe(
        1,
      );
      expect((await poll(cancelled)).response.status).toBe(400);
    });

    it('invalidates keys on real password change and user deletion', async () => {
      const owner = await signup();
      const key = await newKey(['app.read'], { mode: 'all' }, owner.cookie);
      const changed = await auth.handler(
        new Request(`${origin}/api/auth/change-password`, {
          method: 'POST',
          headers: {
            origin,
            cookie: owner.cookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            currentPassword: password,
            newPassword: `${password}-changed`,
          }),
        }),
      );
      expect(changed.status).toBe(200);
      expect(
        (await call('auth/status', undefined, bearer(key))).response.status,
      ).toBe(401);
      const listed = await call<{ id: string; status: string }[]>(
        'auth/keys',
        undefined,
        { cookie: owner.cookie },
      );
      expect(listed.data.find((item) => item.id === key.id)?.status).toBe(
        'revoked',
      );
      const afterChange = await newKey(
        ['app.read'],
        { mode: 'all' },
        owner.cookie,
      );
      expect(
        (await call('auth/status', undefined, bearer(afterChange))).response
          .status,
      ).toBe(200);
      const deleted = await signup();
      const deletedKey = await newKey(
        ['app.read'],
        { mode: 'all' },
        deleted.cookie,
      );
      await database.db
        .delete(database.schema.user)
        .where(eq(database.schema.user.id, deleted.userId));
      expect(
        (await call('auth/status', undefined, bearer(deletedKey))).response
          .status,
      ).toBe(401);
    });

    it('mints and renews through a real protocol-18 Runner connection and internal HTTP auth', async () => {
      const run = await assignedRun();
      expect(
        (await internal(run.runId, { runnerId }, 'wrong-token')).response
          .status,
      ).toBe(401);
      expect(
        (await internal(run.runId, { runnerId: 'other-runner' })).response
          .status,
      ).toBe(403);
      const key = await internal(run.runId, { runnerId });
      expect(key.response.status).toBe(200);
      const status = await call('auth/status', undefined, bearer(key.data));
      expect(status.response.status).toBe(200);
      expect(status.data.credentialType).toBe('run_key');
      expect(status.data.context).toEqual({ ...run, runnerId });
      expect(
        (await call('auth/revoke-self', {}, bearer(key.data))).response.status,
      ).toBe(403);
      const renewed = await internal(
        run.runId,
        { runnerId, credentialId: key.data.id },
        'test-fleet-token',
        true,
      );
      expect(renewed.response.status).toBe(200);
      const another = await assignedRun();
      expect(
        (
          await internal(
            another.runId,
            { runnerId, credentialId: key.data.id },
            'test-fleet-token',
            true,
          )
        ).response.status,
      ).toBe(409);
    });

    it.each(['cancelled', 'completed', 'failed'] as const)(
      'immediately rejects an already-minted key after run becomes %s',
      async (status) => {
        const run = await assignedRun();
        const key = await internal(run.runId, { runnerId });
        expect(key.response.status).toBe(200);
        await database.db
          .update(database.schema.agentRuns)
          .set({ status })
          .where(eq(database.schema.agentRuns.id, run.runId));
        expect(
          (await call('auth/status', undefined, bearer(key.data))).response
            .status,
        ).toBe(401);
        expect(
          (
            await internal(
              run.runId,
              { runnerId, credentialId: key.data.id },
              'test-fleet-token',
              true,
            )
          ).response.status,
        ).toBe(401);
      },
    );

    it('rejects a Run key as soon as its lease lapses', async () => {
      const run = await assignedRun();
      const key = await internal(run.runId, { runnerId });
      expect(key.response.status).toBe(200);
      await database.db
        .update(database.schema.agentRuns)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(database.schema.agentRuns.id, run.runId));
      expect(
        (await call('auth/status', undefined, bearer(key.data))).response
          .status,
      ).toBe(401);
      expect((await internal(run.runId, { runnerId })).response.status).toBe(
        401,
      );
    });

    it('never mints Run keys for runs without a Cookie issuer', async () => {
      const run = await assignedRun();
      await database.db
        .update(database.schema.agentRuns)
        .set({ startedByUserId: null })
        .where(eq(database.schema.agentRuns.id, run.runId));
      expect((await internal(run.runId, { runnerId })).response.status).toBe(
        401,
      );
    });

    it('rechecks captured principals at write commit after revocation', async () => {
      const key = await newKey(['app.create']);
      const principal = await credentials.resolveCredential(
        new Request(`${origin}/api/cli/v1/auth/status`, {
          headers: bearer(key),
        }),
      );
      await credentials.revokeOwnedKey(userId, key.id);
      await expect(
        database.db.transaction(async (tx) => {
          await credentials.authorizeCommit(
            principal,
            'app.create',
            undefined,
            tx,
          );
          await tx.insert(database.schema.apps).values({
            id: randomUUID(),
            slug: randomUUID(),
            name: 'Forbidden commit',
          });
        }),
      ).rejects.toThrow('invalid_credential');
    });

    it('resolves an exact immutable ID before a colliding slug', async () => {
      const legacyId = `legacy-${randomUUID()}`;
      const other = randomUUID();
      // A legacy kebab-case ID that another object later took as its slug.
      // The slug holder is stored first, where an unordered match finds it.
      await database.db.insert(database.schema.apps).values([
        { id: other, slug: legacyId, name: 'Slug holder' },
        { id: legacyId, slug: `renamed-${randomUUID()}`, name: 'Legacy' },
      ]);
      const all = await newKey(['app.read']);
      for (let attempt = 0; attempt < 5; attempt++) {
        const found = await call<{ id: string }>(
          `apps/${legacyId}`,
          undefined,
          bearer(all),
        );
        expect(found.data.id).toBe(legacyId);
      }
      const finite = await newKey(['app.read'], {
        mode: 'ids',
        apps: [legacyId],
        workflows: [],
      });
      expect(
        (await call(`apps/${legacyId}`, undefined, bearer(finite))).response
          .status,
      ).toBe(200);
    });

    it('grants nothing to plugin keys without Hatch metadata', async () => {
      const pluginOnly = await auth.api.createApiKey({
        body: {
          configId: 'hatch',
          name: 'No metadata',
          expiresIn: 300,
          userId,
          permissions: { hatch: ['app.read'] },
        },
      });
      expect(
        (
          await call('auth/status', undefined, {
            authorization: `Bearer ${pluginOnly.key}`,
          })
        ).response.status,
      ).toBe(401);
      const key = await newKey();
      expect(
        (await call(`auth/keys/${key.id}/revoke`, {}, { cookie })).response
          .status,
      ).toBe(200);
      expect(
        (await call('auth/status', undefined, bearer(key))).response.status,
      ).toBe(401);
      expect(
        Boolean(
          await auth.api.getSession({ headers: new Headers({ cookie }) }),
        ),
      ).toBe(true);
    });
  },
);
