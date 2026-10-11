/** Real PostgreSQL, Better Auth and production request handlers; no auth mocks. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeySummary, CreatedApiKey } from '~auth/api-key-contract';

const databaseUrl = process.env.HATCH_API_KEY_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4317';
let database: typeof import('~/db');
let auth: typeof import('~auth/server').auth;
let manage: typeof import('./api-keys').handleApiKeysRequest;
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
  suffix = '',
) => manage(request(`/api/settings/api-keys${suffix}`, headers, body));
const inventory = (headers: Record<string, string>, path = 'apps') =>
  cli(request(`/api/cli/v1/${path}`, headers));
async function create(expiresIn: number | null = null) {
  const response = await management(
    { cookie: owner },
    { name: 'Automation', expiresIn },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
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
    manage = (await import('./api-keys')).handleApiKeysRequest;
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
      where: { id: created.apiKey.id },
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
    const keys = JSON.parse(text).keys as ApiKeySummary[];
    expect(
      keys.find((key) => key.id === created.apiKey.id)?.lastRequest,
    ).not.toBeNull();
    expect(
      (
        await management(
          { cookie: owner },
          { id: created.apiKey.id },
          '/revoke',
        )
      ).status,
    ).toBe(200);
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await inventory({ 'x-api-key': created.key })).status).toBe(401);
    expect((await inventory({ cookie: owner })).status).toBe(200);
    expect(
      (
        await management(
          { cookie: owner },
          { id: created.apiKey.id },
          '/revoke',
        )
      ).status,
    ).toBe(404);
  });

  it('isolates key owners and rejects key-only management and plugin bypasses', async () => {
    const created = await create();
    const list = await management({ cookie: other });
    expect((await list.json()).keys).toEqual([]);
    expect(
      (
        await management(
          { cookie: other },
          { id: created.apiKey.id },
          '/revoke',
        )
      ).status,
    ).toBe(404);
    expect((await inventory({ 'x-api-key': created.key })).status).toBe(200);
    const credentials: Record<string, string>[] = [
      { 'x-api-key': created.key },
      { authorization: `Bearer ${created.key}` },
      { 'x-api-key': created.key, cookie: owner },
    ];
    for (const headers of credentials) {
      expect((await management(headers)).status).toBe(401);
      expect(
        (await management(headers, { name: 'Escalation', expiresIn: null }))
          .status,
      ).toBe(401);
      expect(
        (await management(headers, { id: created.apiKey.id }, '/revoke'))
          .status,
      ).toBe(401);
    }
    expect(
      await (
        await authCall('get-session', undefined, { 'x-api-key': created.key })
      ).json(),
    ).toBeNull();
    for (const [path, body] of [
      ['api-key/create', { name: 'Bypass', userId: historicalId }],
      ['api-key/list', undefined],
      ['api-key/get?id=' + created.apiKey.id, undefined],
      ['api-key/delete', { keyId: created.apiKey.id }],
      ['api-key/update', { keyId: created.apiKey.id, userId: historicalId }],
      ['api-key/verify', { key: created.key }],
    ] as const)
      expect((await authCall(path, body, { cookie: owner })).status).toBe(404);
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
      (
        await management(
          { cookie: owner },
          { id: created.apiKey.id },
          '/revoke',
        )
      ).status,
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
    expect(Date.parse(expiring.apiKey.expiresAt!)).toBeGreaterThan(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await inventory({ 'x-api-key': expiring.key, cookie: owner })).status,
    ).toBe(401);
    const disabled = await create();
    await database.db
      .update(database.schema.apikey)
      .set({ enabled: false })
      .where(eq(database.schema.apikey.id, disabled.apiKey.id));
    expect((await inventory({ 'x-api-key': disabled.key })).status).toBe(401);
    await database.db
      .update(database.schema.apikey)
      .set({ enabled: true, referenceId: 'deleted-owner' })
      .where(eq(database.schema.apikey.id, disabled.apiKey.id));
    expect((await inventory({ 'x-api-key': disabled.key })).status).toBe(401);
    for (const key of ['', 'hatch_invalid', 'a.b.c', `hatch_${'a'.repeat(64)}`])
      expect(
        (await inventory({ 'x-api-key': key, cookie: owner })).status,
      ).toBe(401);
  });

  it('validates mutations and prevents cross-origin and ownership injection', async () => {
    expect((await management({})).status).toBe(401);
    for (const input of [
      { name: '', expiresIn: null },
      { name: 'Key', expiresIn: 0 },
      { name: 'Key', expiresIn: -1 },
      { name: 'Key', expiresIn: 315360001 },
      { name: 'Key', expiresIn: null, userId: historicalId },
    ])
      expect((await management({ cookie: owner }, input)).status).toBe(400);
    expect(
      (
        await management(
          { cookie: owner, origin: 'https://attacker.test' },
          { name: 'Key', expiresIn: null },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await management(
          { cookie: owner, 'content-type': 'text/plain' },
          { name: 'Key', expiresIn: null },
        )
      ).status,
    ).toBe(415);
  });
});
