import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.stubEnv('APP_URL', 'https://public.example.test');
vi.stubEnv('SECRET', 'platform-secret');

const { db, schema } = await import('~/db');
const { decryptAppDbPassword, encryptAppDbPassword } =
  await import('./db-password');
const { decryptKvSecret, encryptKvSecret } = await import('./kv-secret');
const { getKv, listKv, setKv } = await import('./kv');

const APP_ID = 'kv-storage';

async function seedApp(id = APP_ID) {
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: `App ${id}`,
    status: 'deployed',
  });
}

async function rawKv(key: string, appId = APP_ID) {
  const row = await db.query.appKv.findFirst({
    where: (t, { and, eq: equals }) =>
      and(equals(t.appId, appId), equals(t.key, key)),
  });
  if (!row) throw new Error(`Missing raw KV row for ${appId}/${key}`);
  return row;
}

beforeEach(async () => {
  await db.delete(schema.apps);
  await seedApp();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('KV secret storage', () => {
  it('uses an encryption domain independent from database passwords', () => {
    const password = '0123456789abcdef'.repeat(4);
    const kvEnvelope = encryptKvSecret(APP_ID, 'token', password, 64 * 1024);
    const passwordEnvelope = encryptAppDbPassword(APP_ID, password);

    expect(() => decryptAppDbPassword(APP_ID, kvEnvelope)).toThrow(
      'authentication failed or ciphertext is corrupted',
    );
    expect(() =>
      decryptKvSecret(APP_ID, 'token', passwordEnvelope, 64 * 1024),
    ).toThrow('authentication failed or ciphertext is corrupted');
  });

  it('stores new secrets only as ciphertext and returns plaintext to trusted reads', async () => {
    const plaintext = 'secret-that-must-not-be-stored';

    const created = await setKv(APP_ID, ' api-token ', plaintext, {
      secret: true,
    });
    const raw = await rawKv('api-token');

    expect(created).toMatchObject({
      key: 'api-token',
      value: plaintext,
      secret: true,
    });
    expect(raw).toMatchObject({
      key: 'api-token',
      value: null,
      secret: true,
    });
    expect(raw.valueCiphertext).toMatch(/^v1\./);
    expect(raw.valueCiphertext).not.toContain(plaintext);
    await expect(getKv(APP_ID, 'api-token')).resolves.toMatchObject({
      value: plaintext,
      secret: true,
    });
    await expect(listKv(APP_ID)).resolves.toMatchObject([
      { key: 'api-token', value: plaintext, secret: true },
    ]);
  });

  it('uses a fresh nonce whenever an existing secret is overwritten', async () => {
    await setKv(APP_ID, 'token', 'same-value', { secret: true });
    const first = (await rawKv('token')).valueCiphertext;

    await setKv(APP_ID, 'token', 'same-value');
    const second = (await rawKv('token')).valueCiphertext;

    expect(first).toMatch(/^v1\./);
    expect(second).toMatch(/^v1\./);
    expect(second).not.toBe(first);
    await expect(getKv(APP_ID, 'token')).resolves.toMatchObject({
      value: 'same-value',
      secret: true,
    });
  });

  it('reads legacy plaintext secrets without rewriting them and encrypts on overwrite', async () => {
    await db.insert(schema.appKv).values({
      appId: APP_ID,
      key: 'legacy-token',
      value: 'legacy-plaintext',
      secret: true,
    });
    const before = await rawKv('legacy-token');

    await expect(getKv(APP_ID, 'legacy-token')).resolves.toMatchObject({
      value: 'legacy-plaintext',
      secret: true,
    });
    await expect(listKv(APP_ID)).resolves.toMatchObject([
      { key: 'legacy-token', value: 'legacy-plaintext', secret: true },
    ]);
    expect(await rawKv('legacy-token')).toEqual(before);

    await setKv(APP_ID, 'legacy-token', 'replacement');
    const migrated = await rawKv('legacy-token');
    expect(migrated).toMatchObject({ value: null, secret: true });
    expect(migrated.valueCiphertext).toMatch(/^v1\./);
    expect(migrated.valueCiphertext).not.toContain('replacement');
    await expect(getKv(APP_ID, 'legacy-token')).resolves.toMatchObject({
      value: 'replacement',
      secret: true,
    });
  });

  it('keeps exactly one storage representation across secret state transitions', async () => {
    await setKv(APP_ID, 'mode', 'plain');
    expect(await rawKv('mode')).toMatchObject({
      value: 'plain',
      valueCiphertext: null,
      secret: false,
    });

    await setKv(APP_ID, 'mode', 'encrypted', { secret: true });
    const encrypted = await rawKv('mode');
    expect(encrypted).toMatchObject({
      value: null,
      secret: true,
    });
    expect(encrypted.valueCiphertext).toMatch(/^v1\./);

    await setKv(APP_ID, 'mode', 'still-encrypted');
    const preserved = await rawKv('mode');
    expect(preserved).toMatchObject({
      value: null,
      secret: true,
    });
    expect(preserved.valueCiphertext).toMatch(/^v1\./);

    await setKv(APP_ID, 'mode', 'visible-again', { secret: false });
    expect(await rawKv('mode')).toMatchObject({
      value: 'visible-again',
      valueCiphertext: null,
      secret: false,
    });
  });

  it('encrypts empty, Unicode, and maximum-size values using plaintext limits', async () => {
    const values = [
      ['empty', ''],
      ['unicode', '密钥🔐'],
      ['maximum', 'x'.repeat(64 * 1024)],
      ['multibyte-maximum', `${'密'.repeat(21_845)}a`],
    ] as const;

    for (const [key, value] of values) {
      await setKv(APP_ID, key, value, { secret: true });
      const raw = await rawKv(key);
      expect(raw).toMatchObject({ value: null, secret: true });
      expect(raw.valueCiphertext).toMatch(/^v1\./);
      await expect(getKv(APP_ID, key)).resolves.toMatchObject({ value });
    }

    await expect(
      setKv(APP_ID, 'too-large', 'x'.repeat(64 * 1024 + 1), {
        secret: true,
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      setKv(APP_ID, 'multibyte-too-large', `${'密'.repeat(21_845)}ab`, {
        secret: true,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('rejects malformed Unicode keys before storing encrypted data', async () => {
    await expect(
      setKv(APP_ID, 'broken-\ud800-key', 'secret', { secret: true }),
    ).rejects.toMatchObject({
      message: 'KV key must contain valid Unicode.',
      status: 400,
    });
    await expect(
      setKv(APP_ID, 'broken-\udc00-key', 'secret', { secret: true }),
    ).rejects.toMatchObject({ status: 400 });

    await setKv(APP_ID, 'valid-🔐-key', 'secret', { secret: true });
    await expect(getKv(APP_ID, 'valid-🔐-key')).resolves.toMatchObject({
      value: 'secret',
      secret: true,
    });

    const rows = await db.query.appKv.findMany({
      where: (table, { eq: equals }) => equals(table.appId, APP_ID),
    });
    expect(rows.map((row) => row.key)).toEqual(['valid-🔐-key']);
  });

  it('enforces valid plaintext and ciphertext column combinations in the database', async () => {
    const invalidStates = [
      {
        key: 'plain-with-ciphertext',
        value: 'plaintext',
        valueCiphertext: 'v1.ciphertext',
        secret: false,
      },
      {
        key: 'plain-with-neither',
        value: null,
        valueCiphertext: null,
        secret: false,
      },
      {
        key: 'secret-with-both',
        value: 'plaintext',
        valueCiphertext: 'v1.ciphertext',
        secret: true,
      },
      {
        key: 'secret-with-neither',
        value: null,
        valueCiphertext: null,
        secret: true,
      },
    ] as const;

    for (const state of invalidStates) {
      const error = await db
        .insert(schema.appKv)
        .values({ appId: APP_ID, ...state })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ cause: { code: '23514' } });
    }
  });

  it('sanitizes database write failures without exposing secret parameters', async () => {
    const plaintext = 'must-never-appear-in-an-error';
    const failure = await setKv('missing-app', 'token', plaintext, {
      secret: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 500,
      message: 'Unable to store KV value.',
    });
    expect(String((failure as Error).message)).not.toContain(plaintext);
    expect(String((failure as Error).message)).not.toContain('v1.');
    expect(String((failure as Error).message)).not.toContain('params:');
  });

  it('fails closed when ciphertext is corrupted or moved to another key', async () => {
    await setKv(APP_ID, 'source', 'do-not-leak', { secret: true });
    const original = await rawKv('source');
    const envelope = original.valueCiphertext;
    if (!envelope) throw new Error('Expected encrypted KV value.');
    const last = envelope.at(-1);
    const corruptedEnvelope = `${envelope.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

    await db
      .update(schema.appKv)
      .set({ valueCiphertext: corruptedEnvelope })
      .where(eq(schema.appKv.id, original.id));

    const corrupted = await getKv(APP_ID, 'source').catch(
      (error: unknown) => error,
    );
    expect(corrupted).toMatchObject({ status: 500 });
    expect(String((corrupted as Error).message)).not.toContain(envelope);
    expect(String((corrupted as Error).message)).not.toContain('do-not-leak');

    await setKv(APP_ID, 'bound-source', 'bound-secret', { secret: true });
    const bound = await rawKv('bound-source');
    await db
      .update(schema.appKv)
      .set({ key: 'moved-key' })
      .where(eq(schema.appKv.id, bound.id));

    const moved = await getKv(APP_ID, 'moved-key').catch(
      (error: unknown) => error,
    );
    expect(moved).toMatchObject({ status: 500 });
    expect(String((moved as Error).message)).not.toContain(
      bound.valueCiphertext ?? '',
    );
    expect(String((moved as Error).message)).not.toContain('bound-secret');

    await seedApp('other-app');
    await db.insert(schema.appKv).values({
      appId: 'other-app',
      key: 'bound-source',
      value: null,
      valueCiphertext: bound.valueCiphertext,
      secret: true,
    });
    const crossApp = await getKv('other-app', 'bound-source').catch(
      (error: unknown) => error,
    );
    expect(crossApp).toMatchObject({ status: 500 });
    expect(String((crossApp as Error).message)).not.toContain(
      bound.valueCiphertext ?? '',
    );
    expect(String((crossApp as Error).message)).not.toContain('bound-secret');
  });
});
