import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.stubEnv('APP_URL', 'https://public.example.test');
vi.stubEnv('SECRET', 'platform-secret');

const { db, schema } = await import('~/db');
const { hatchSignature, HATCH_SIGNATURE_HEADER, HATCH_TIMESTAMP_HEADER } =
  await import('~server/secrets');
const { handle } = await import('~/routes/api/app/$appId/kv/$.ts');

const APP_ID = 'signed-kv';
const SIGNING_SECRET = 'app-signing-secret';

const KV_CAPABILITIES = {
  database: false,
  frontend: false,
  widgets: false,
  backend: true,
  cron: false,
  webhook: false,
  storage: false,
  kv: true,
};

function signedRequest(
  path: string,
  init: { method?: string; body?: string } = {},
) {
  const timestamp = String(Date.now());
  const body = init.body ?? '';
  return new Request(`https://hatch.test${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      [HATCH_TIMESTAMP_HEADER]: timestamp,
      [HATCH_SIGNATURE_HEADER]: hatchSignature(SIGNING_SECRET, timestamp, body),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

async function rawKv(key: string) {
  const row = await db.query.appKv.findFirst({
    where: { appId: APP_ID, key },
  });
  if (!row) throw new Error(`Missing raw KV row for ${key}`);
  return row;
}

beforeEach(async () => {
  await db.delete(schema.apps);
  await db.insert(schema.apps).values({
    id: APP_ID,
    slug: APP_ID,
    name: 'Signed KV app',
    status: 'deployed',
    currentDeploymentId: 'deployment-signed-kv',
    capabilities: KV_CAPABILITIES,
    signingSecret: SIGNING_SECRET,
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('signed app KV route secret storage', () => {
  it('returns plaintext to the app while storing no plaintext or envelope in the response', async () => {
    const plaintext = 'backend-visible-secret';
    const body = JSON.stringify({ value: plaintext, secret: true });

    const put = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv/api-token`, {
        method: 'PUT',
        body,
      }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    const raw = await rawKv('api-token');
    expect(JSON.parse(putText)).toMatchObject({
      key: 'api-token',
      value: plaintext,
      secret: true,
    });
    expect(putText).not.toContain(raw.valueCiphertext ?? 'missing-envelope');
    expect(putText).not.toContain('valueCiphertext');
    expect(raw).toMatchObject({ value: null, secret: true });
    expect(raw.valueCiphertext).toMatch(/^v1\./);

    const get = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv/api-token`),
    });
    expect(get.status).toBe(200);
    const getText = await get.text();
    expect(JSON.parse(getText)).toMatchObject({
      key: 'api-token',
      value: plaintext,
      secret: true,
    });
    expect(getText).not.toContain(raw.valueCiphertext ?? 'missing-envelope');
    expect(getText).not.toContain('valueCiphertext');

    const list = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv`),
    });
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(JSON.parse(listText)).toMatchObject({
      items: [{ key: 'api-token', value: plaintext, secret: true }],
    });
    expect(listText).not.toContain(raw.valueCiphertext ?? 'missing-envelope');
    expect(listText).not.toContain('valueCiphertext');

    await db.insert(schema.appKv).values({
      appId: APP_ID,
      key: 'legacy-token',
      value: 'legacy-plaintext',
      secret: true,
    });
    const legacyGet = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv/legacy-token`),
    });
    expect(legacyGet.status).toBe(200);
    await expect(legacyGet.json()).resolves.toMatchObject({
      key: 'legacy-token',
      value: 'legacy-plaintext',
      secret: true,
    });
  });

  it('returns a safe server error instead of ciphertext when decryption fails', async () => {
    const plaintext = 'never-leak-this';
    const body = JSON.stringify({ value: plaintext, secret: true });
    const put = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv/broken`, {
        method: 'PUT',
        body,
      }),
    });
    expect(put.status).toBe(200);

    const raw = await rawKv('broken');
    const envelope = raw.valueCiphertext;
    if (!envelope) throw new Error('Expected encrypted KV value.');
    const last = envelope.at(-1);
    const corrupted = `${envelope.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    await db
      .update(schema.appKv)
      .set({ valueCiphertext: corrupted })
      .where(eq(schema.appKv.id, raw.id));

    const get = await handle({
      request: signedRequest(`/api/app/${APP_ID}/kv/broken`),
    });
    expect(get.status).toBe(500);
    const response = await get.text();
    expect(response).not.toContain(envelope);
    expect(response).not.toContain(corrupted);
    expect(response).not.toContain(plaintext);
  });
});
