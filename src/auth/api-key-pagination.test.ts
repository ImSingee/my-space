import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { betterAuth } from 'better-auth/minimal';
import { expect, test } from 'vitest';
import { createTestDb } from '~/db/test-db';
import { apiKeyOptions } from './api-key-options';

test('native key listing and pagination include credentials beyond the adapter default limit', async () => {
  const { db, schema } = await createTestDb();
  const origin = 'http://localhost:4317';
  const auth = betterAuth({
    baseURL: origin,
    secret: 'hatch-pagination-isolated-test-secret',
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    plugins: [apiKey(apiKeyOptions)],
  });
  try {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Owner',
          email: 'owner@pagination.test',
          password: 'Hatch-pagination-fixture-93',
        }),
      }),
    );
    expect(response.status).toBe(200);
    const { user } = await response.json();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const ids = [];
    for (let index = 0; index < 101; index++) {
      const key = await auth.api.createApiKey({
        body: { userId: user.id, name: `Automation ${index}` },
      });
      ids.push(key.id);
    }
    await auth.api.createApiKey({
      body: { userId: 'another-owner', name: 'Foreign key' },
    });
    const list = async (search = '') => {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/api-key/list${search}`, {
          headers: { cookie },
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const complete = await list();
    expect(complete.total).toBe(101);
    expect(
      complete.apiKeys.map((key: { id: string }) => key.id).sort(),
    ).toEqual(ids.sort());
    expect(complete.apiKeys.every((key: object) => !('key' in key))).toBe(true);
    const first = await list('?limit=100&offset=0');
    const last = await list('?limit=100&offset=100');
    expect(first.total).toBe(101);
    expect(last.total).toBe(101);
    expect(first.apiKeys).toHaveLength(100);
    expect(last.apiKeys).toHaveLength(1);
    expect(
      [...first.apiKeys, ...last.apiKeys]
        .map((key: { id: string }) => key.id)
        .sort(),
    ).toEqual(ids);
  } finally {
    await db.$client.close();
  }
}, 30000);
