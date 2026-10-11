/** Real PostgreSQL, Better Auth and production request handlers; no auth mocks. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeyMetadata } from '~auth/api-key-contract';

const databaseUrl = process.env.HATCH_API_KEY_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4317';
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let cli: typeof import('./cli/api').handleCliApiRequest;
let owner: string;
let other: string;
let runtimeDir: string;
const historicalId = randomUUID();
const historicalToken = randomUUID();

async function authCall(path: string, body?: unknown, headers = {}) {
  return auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
async function signup() {
  const email = `${randomUUID()}@hatch-api-key.test`;
  const password = 'Hatch-isolated-test-password-93';
  expect(
    (await authCall('sign-up/email', { email, password, name: 'Key owner' }))
      .status,
  ).toBe(200);
  const response = await authCall('sign-in/email', { email, password });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
const request = (
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) =>
  new Request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const management = (
  headers: Record<string, string>,
  body?: unknown,
  action = body === undefined ? 'list' : 'create',
) => authCall(`api-key/${action}`, body, headers);
const inventory = (headers: Record<string, string>, path = 'apps') =>
  cli(request(`/api/cli/v1/${path}`, headers));
type CreatedApiKey = ApiKeyMetadata & { key: string };
async function create(
  expiresIn: number | null = null,
  prefix: string | null = 'hatch_',
) {
  const response = await management(
    { cookie: owner },
    { name: 'Automation', expiresIn, ...(prefix === null ? {} : { prefix }) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<CreatedApiKey>;
}

describe.runIf(Boolean(databaseUrl))('API keys on real PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.APP_URL = origin;
    process.env.SECRET = 'hatch-api-keys-isolated-test-secret-6378';
    runtimeDir = await mkdtemp(join(tmpdir(), 'hatch-key-tests-'));
    process.env.HATCH_DATA_DIR = runtimeDir;
    database = await import('~/db');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const baseline = await mkdtemp(join(tmpdir(), 'hatch-key-baseline-'));
    try {
      for (const entry of await readdir('migrations')) {
        if (entry < '20261011102409')
          await cp(join('migrations', entry), join(baseline, entry), {
            recursive: true,
          });
      }
      await migrate(database.db, { migrationsFolder: baseline });
      await database.db.insert(database.schema.user).values({
        id: historicalId,
        name: 'Historical owner',
        email: `${historicalId}@historical.test`,
      });
      await database.db.insert(database.schema.session).values({
        id: randomUUID(),
        userId: historicalId,
        token: historicalToken,
        expiresAt: new Date(Date.now() + 86400000),
      });
      await migrate(database.db, { migrationsFolder: 'migrations' });
      await migrate(database.db, { migrationsFolder: 'migrations' });
    } finally {
      await rm(baseline, { recursive: true, force: true });
    }
    auth = (await import('~auth/server')).auth;
    // Better Auth skips origin checks under NODE_ENV=test. Exercise the same
    // origin enforcement as the production handler instead.
    (await auth.$context).skipOriginCheck = false;
    cli = (await import('./cli/api')).handleCliApiRequest;
    owner = await signup();
    other = await signup();
  }, 30000);
  afterAll(async () => {
    await database?.db.$client.end();
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
  });

  it('preserves historical users and sessions across upgrade and repeated migration', async () => {
    const response = await authCall('get-session', undefined, {
      authorization: `Bearer ${historicalToken}`,
    });
    expect((await response.json()).user.id).toBe(historicalId);
    expect(
      (await inventory({ authorization: `Bearer ${historicalToken}` })).status,
    ).toBe(200);
  });

  it('creates once, lists metadata only, authenticates CLI and immediately revokes', async () => {
    const created = await create();
    expect(/^hatch_[A-Za-z]{64}$/.test(created.key)).toBe(true);
    const stored = await database.db.query.apikey.findFirst({
      where: { id: created.id },
    });
    expect(stored?.key === created.key).toBe(false);
    expect(stored?.key.includes('hatch_')).toBe(false);
    expect(stored?.expiresAt).toBeNull();
    for (const path of ['apps', 'workflows'])
      expect((await inventory({ 'x-api-key': created.key }, path)).status).toBe(
        200,
      );
    const list = await management({ cookie: owner });
    const text = await list.text();
    expect(text.includes(created.key)).toBe(false);
    expect(text.includes(stored!.key)).toBe(false);
    const keys = JSON.parse(text).apiKeys as ApiKeyMetadata[];
    expect(
      keys.find((key) => key.id === created.id)?.lastRequest,
    ).not.toBeNull();
    expect(
      (await management({ cookie: owner }, { keyId: created.id }, 'delete'))
        .status,
    ).toBe(200);
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(401);
    expect((await inventory({ cookie: owner })).status).toBe(200);
    expect(
      (await management({ cookie: owner }, { keyId: created.id }, 'delete'))
        .status,
    ).toBe(404);
  });

  it('isolates native management by session owner and never treats a key as a session', async () => {
    const created = await create();
    const list = await management({ cookie: other });
    expect((await list.json()).apiKeys).toEqual([]);
    for (const [action, body] of [
      [`get?id=${created.id}`, undefined],
      ['delete', { keyId: created.id }],
      ['update', { keyId: created.id, name: 'Foreign change' }],
    ] as const)
      expect((await management({ cookie: other }, body, action)).status).toBe(
        404,
      );
    expect((await inventory({ 'x-api-key': created.key })).status).toBe(200);
    const credentials: Record<string, string>[] = [
      { 'x-api-key': created.key },
      { authorization: `Bearer ${created.key}` },
    ];
    for (const headers of credentials) {
      expect((await management(headers)).status).toBe(401);
      expect((await management(headers, { name: 'Escalation' })).status).toBe(
        401,
      );
      expect(
        (await management(headers, { keyId: created.id }, 'delete')).status,
      ).toBe(401);
      expect(
        (
          await management(
            headers,
            { keyId: created.id, expiresIn: null },
            'update',
          )
        ).status,
      ).toBe(401);
    }
    expect(
      await (
        await authCall('get-session', undefined, { 'x-api-key': created.key })
      ).json(),
    ).toBeNull();
    // A real session remains the management identity when a key accompanies it.
    expect(
      (await management({ cookie: owner, 'x-api-key': created.key })).status,
    ).toBe(200);
    expect(
      (
        await management(
          { cookie: other, 'x-api-key': created.key },
          { keyId: created.id },
          'delete',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await authCall(
          'api-key/verify',
          { key: created.key },
          { cookie: owner },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await authCall(
          'api-key/delete-all-expired-api-keys',
          {},
          { cookie: owner },
        )
      ).status,
    ).toBe(404);
    for (const path of [
      'users',
      'secrets',
      'runners',
      'api-keys',
      'apps/example/query-db',
    ])
      expect((await inventory({ 'x-api-key': created.key }, path)).status).toBe(
        404,
      );
  });

  it('authenticates native keys with custom or absent prefixes and honors owner updates', async () => {
    for (const prefix of ['script_', null]) {
      const created = await create(60, prefix);
      expect(created.prefix).toBe(prefix);
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(200);
      const updated = await management(
        { cookie: owner },
        { keyId: created.id, enabled: false },
        'update',
      );
      expect(updated.status).toBe(200);
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(401);
      expect(
        (
          await management(
            { cookie: owner },
            { keyId: created.id, enabled: true, expiresIn: null },
            'update',
          )
        ).status,
      ).toBe(200);
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(200);
      const details = await management(
        { cookie: owner },
        undefined,
        `get?id=${created.id}`,
      );
      expect(details.status).toBe(200);
      const text = await details.text();
      expect(text.includes(created.key)).toBe(false);
      expect(JSON.parse(text).expiresAt).toBeNull();
      expect(
        (await management({ cookie: owner }, { keyId: created.id }, 'delete'))
          .status,
      ).toBe(200);
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(401);
    }
  });

  it('allows the existing App/Workflow write and source routes, then denies them after revoke', async () => {
    const created = await create();
    const headers = { 'x-api-key': created.key };
    for (const kind of ['apps', 'workflows']) {
      const response = await cli(
        request(`/api/cli/v1/${kind}`, headers, {
          slug: `key-fixture-${randomUUID().slice(0, 8)}`,
          name: 'Key-created resource',
          pin: false,
        }),
      );
      expect(response.status).toBe(200);
      const resource = (await response.json()) as {
        id: string;
        files: unknown[];
      };
      expect(resource.files.length).toBeGreaterThan(0);
      const metadata = await inventory(headers, `${kind}/${resource.id}`);
      expect(metadata.status).toBe(200);
      expect((await metadata.json()).id).toBe(resource.id);
      expect(
        (await inventory(headers, `${kind}/${resource.id}/source`)).status,
      ).toBe(200);
      for (const action of ['deploy', 'rollback'])
        expect(
          (
            await cli(
              request(
                `/api/cli/v1/${kind}/${resource.id}/${action}`,
                headers,
                {},
              ),
            )
          ).status,
        ).toBe(400);
    }
    expect(
      (await management({ cookie: owner }, { keyId: created.id }, 'delete'))
        .status,
    ).toBe(200);
    for (const kind of ['apps', 'workflows']) {
      expect(
        (await cli(request(`/api/cli/v1/${kind}`, headers, {}))).status,
      ).toBe(401);
      for (const action of ['deploy', 'rollback'])
        expect(
          (
            await cli(
              request(`/api/cli/v1/${kind}/example/${action}`, headers, {}),
            )
          ).status,
        ).toBe(401);
    }
  });

  it('rejects invalid, expired, disabled and orphan keys without credential fallback', async () => {
    const expiring = await create(1);
    expect(Date.parse(expiring.expiresAt!)).toBeGreaterThan(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await inventory({ 'x-api-key': expiring.key, cookie: owner })).status,
    ).toBe(401);
    const disabled = await create();
    await database.db
      .update(database.schema.apikey)
      .set({ enabled: false })
      .where(eq(database.schema.apikey.id, disabled.id));
    expect((await inventory({ 'x-api-key': disabled.key })).status).toBe(401);
    await database.db
      .update(database.schema.apikey)
      .set({ enabled: true, referenceId: 'deleted-owner' })
      .where(eq(database.schema.apikey.id, disabled.id));
    expect((await inventory({ 'x-api-key': disabled.key })).status).toBe(401);
    for (const key of ['', 'hatch_invalid', 'a.b.c', `hatch_${'a'.repeat(64)}`])
      expect(
        (await inventory({ 'x-api-key': key, cookie: owner })).status,
      ).toBe(401);
  });

  it('enforces native input, origin and server-only identity boundaries', async () => {
    expect((await management({})).status).toBe(401);
    for (const input of [
      { name: '', expiresIn: null },
      { name: 'Key', expiresIn: 0 },
      { name: 'Key', expiresIn: -1 },
      { name: 'Key', expiresIn: 315360001 },
      { name: 'Key', permissions: { app: ['write'] } },
    ])
      expect((await management({ cookie: owner }, input)).status).toBe(400);
    expect(
      (
        await management(
          { cookie: owner },
          { name: 'Key', userId: historicalId },
        )
      ).status,
    ).toBe(401);
    const created = await create();
    expect(
      (
        await management(
          { cookie: owner },
          { keyId: created.id, userId: historicalId, name: 'Injected' },
          'update',
        )
      ).status,
    ).toBe(401);
    for (const [action, body] of [
      ['create', { name: 'Key', expiresIn: null }],
      ['delete', { keyId: created.id }],
      ['update', { keyId: created.id, expiresIn: null }],
    ] as const)
      expect(
        (
          await management(
            { cookie: owner, origin: 'https://attacker.test' },
            body,
            action,
          )
        ).status,
      ).toBe(403);
  });
});
