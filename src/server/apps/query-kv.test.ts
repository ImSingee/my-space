import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryAppKvRequest } from '~agent/protocol';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.stubEnv('APP_URL', 'https://public.example.test');
vi.stubEnv('SECRET', 'platform-secret');

const { db, schema } = await import('~/db');
const { queryAppKvRequestSchema } = await import('~agent/protocol');
const { listKvPage } = await import('./kv');
const { queryAppKv: executeQueryAppKv } = await import('./query-kv');

async function queryAppKv(id: string, input: QueryAppKvRequest) {
  return executeQueryAppKv(id, queryAppKvRequestSchema.parse(input));
}

const KV_CAPABILITIES = {
  database: false,
  frontend: false,
  widgets: false,
  backend: true,
  cron: false,
  webhook: false,
  kv: true,
};

async function seedApp(
  id: string,
  overrides: Partial<typeof schema.apps.$inferInsert> = {},
) {
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: `App ${id}`,
    status: 'deployed',
    capabilities: KV_CAPABILITIES,
    currentDeploymentId: `dep-${id}`,
    ...overrides,
  });
}

beforeEach(async () => {
  await db.delete(schema.apps);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('queryAppKv guards', () => {
  it('requires a non-archived app with KV enabled', async () => {
    await seedApp('archived', { status: 'archived' });
    await seedApp('without-kv', {
      capabilities: { ...KV_CAPABILITIES, kv: false },
    });

    for (const id of ['missing', 'archived', 'without-kv']) {
      await expect(
        queryAppKv(id, { action: 'list', limit: 100 }),
      ).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe('queryAppKv operations', () => {
  it('masks secrets by default and reveals them only when requested', async () => {
    await seedApp('secrets');

    const set = await queryAppKv('secrets', {
      action: 'set',
      key: 'api-token',
      value: 'plain-secret',
      secret: true,
    });
    expect(set).toMatchObject({
      action: 'set',
      record: { key: 'api-token', value: null, secret: true },
    });
    const stored = await db.query.appKv.findFirst({
      where: (t, { and, eq: equals }) =>
        and(equals(t.appId, 'secrets'), equals(t.key, 'api-token')),
    });
    expect(stored).toMatchObject({
      value: null,
      secret: true,
    });
    expect(stored?.valueCiphertext).toMatch(/^v1\./);
    expect(stored?.valueCiphertext).not.toContain('plain-secret');

    const get = await queryAppKv('secrets', {
      action: 'get',
      key: 'api-token',
    });
    expect(get).toMatchObject({
      action: 'get',
      record: { value: null, secret: true },
    });
    await expect(
      queryAppKv('secrets', {
        action: 'get',
        key: 'api-token',
        revealSecrets: true,
      }),
    ).resolves.toMatchObject({
      action: 'get',
      record: { value: 'plain-secret', secret: true },
    });

    const list = await queryAppKv('secrets', {
      action: 'list',
      limit: 100,
    });
    expect(list).toMatchObject({
      action: 'list',
      items: [{ value: null, secret: true }],
      nextCursor: null,
    });
    await expect(
      queryAppKv('secrets', {
        action: 'list',
        limit: 100,
        revealSecrets: true,
      }),
    ).resolves.toMatchObject({
      action: 'list',
      items: [{ value: 'plain-secret', secret: true }],
      nextCursor: null,
    });
  });

  it('masks a corrupted encrypted secret without decrypting it', async () => {
    await seedApp('corrupted-secret');
    await queryAppKv('corrupted-secret', {
      action: 'set',
      key: 'api-token',
      value: 'never-leak-this',
      secret: true,
    });
    const stored = await db.query.appKv.findFirst({
      where: (t, { and, eq: equals }) =>
        and(equals(t.appId, 'corrupted-secret'), equals(t.key, 'api-token')),
    });
    const envelope = stored?.valueCiphertext;
    if (!stored || !envelope) throw new Error('Expected encrypted KV row.');
    const last = envelope.at(-1);
    const corrupted = `${envelope.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    await db
      .update(schema.appKv)
      .set({ valueCiphertext: corrupted })
      .where(eq(schema.appKv.id, stored.id));

    await expect(
      queryAppKv('corrupted-secret', {
        action: 'get',
        key: 'api-token',
      }),
    ).resolves.toMatchObject({
      action: 'get',
      record: { value: null, secret: true },
    });
    await expect(
      queryAppKv('corrupted-secret', { action: 'list', limit: 100 }),
    ).resolves.toMatchObject({
      action: 'list',
      items: [{ key: 'api-token', value: null, secret: true }],
    });

    const failedReveal = await queryAppKv('corrupted-secret', {
      action: 'get',
      key: 'api-token',
      revealSecrets: true,
    }).catch((error: unknown) => error);
    expect(failedReveal).toMatchObject({ status: 500 });
    expect(String((failedReveal as Error).message)).not.toContain(envelope);
    expect(String((failedReveal as Error).message)).not.toContain(corrupted);
    expect(String((failedReveal as Error).message)).not.toContain(
      'never-leak-this',
    );
  });

  it('applies the same mask and reveal contract to legacy plaintext secrets', async () => {
    await seedApp('legacy-secret');
    await db.insert(schema.appKv).values({
      appId: 'legacy-secret',
      key: 'api-token',
      value: 'legacy-plaintext',
      secret: true,
    });

    await expect(
      queryAppKv('legacy-secret', { action: 'get', key: 'api-token' }),
    ).resolves.toMatchObject({
      action: 'get',
      record: { value: null, secret: true },
    });
    await expect(
      queryAppKv('legacy-secret', {
        action: 'get',
        key: 'api-token',
        revealSecrets: true,
      }),
    ).resolves.toMatchObject({
      action: 'get',
      record: { value: 'legacy-plaintext', secret: true },
    });
  });

  it('preserves secret on update and defaults new keys to non-secret', async () => {
    await seedApp('flags');
    await queryAppKv('flags', {
      action: 'set',
      key: 'secret',
      value: 'first',
      secret: true,
    });

    const updated = await queryAppKv('flags', {
      action: 'set',
      key: 'secret',
      value: 'second',
    });
    expect(updated).toMatchObject({
      record: { value: null, secret: true },
    });
    await expect(
      queryAppKv('flags', {
        action: 'get',
        key: 'secret',
        revealSecrets: true,
      }),
    ).resolves.toMatchObject({ record: { value: 'second', secret: true } });

    const created = await queryAppKv('flags', {
      action: 'set',
      key: 'plain',
      value: 'value',
    });
    expect(created).toMatchObject({ record: { secret: false } });
  });

  it('returns explicit results for missing reads and idempotent deletes', async () => {
    await seedApp('deletes');
    expect(
      await queryAppKv('deletes', { action: 'get', key: 'missing' }),
    ).toEqual({ action: 'get', record: null });

    await queryAppKv('deletes', {
      action: 'set',
      key: 'temporary',
      value: 'value',
    });
    await expect(
      queryAppKv('deletes', { action: 'delete', key: 'temporary' }),
    ).resolves.toEqual({ action: 'delete', ok: true });
    await expect(
      queryAppKv('deletes', { action: 'delete', key: 'temporary' }),
    ).resolves.toEqual({ action: 'delete', ok: false });
  });

  it('sorts by key and paginates without truncating values', async () => {
    await seedApp('paging');
    const value = 'x'.repeat(35_000);
    for (const key of ['beta', 'alpha', 'gamma']) {
      await queryAppKv('paging', { action: 'set', key, value });
    }

    const first = await queryAppKv('paging', {
      action: 'list',
      limit: 100,
    });
    expect(first.action).toBe('list');
    if (first.action !== 'list') throw new Error('Expected list result.');
    expect(first.items.map((item) => item.key)).toEqual(['alpha']);
    expect(first.items[0].value).toHaveLength(35_000);
    expect(first.nextCursor).toBe('alpha');

    const second = await queryAppKv('paging', {
      action: 'list',
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second).toMatchObject({
      action: 'list',
      items: [{ key: 'beta' }],
      nextCursor: 'beta',
    });
  });

  it('applies the key cursor and page limit in the KV database query', async () => {
    await seedApp('db-paging');
    for (const key of ['gamma', 'alpha', 'beta']) {
      await queryAppKv('db-paging', { action: 'set', key, value: key });
    }

    const first = await listKvPage('db-paging', { limit: 1 });
    expect(first).toMatchObject({
      items: [{ key: 'alpha' }],
      hasMore: true,
    });
    const second = await listKvPage('db-paging', {
      after: first.items[0].key,
      limit: 1,
    });
    expect(second).toMatchObject({
      items: [{ key: 'beta' }],
      hasMore: true,
    });
    await expect(
      listKvPage('db-paging', {
        after: second.items[0].key,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      items: [{ key: 'gamma' }],
      hasMore: false,
    });
  });
});
