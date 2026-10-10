import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';

describe('Passkey migration', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    database = await createTestDb();
  }, 30_000);

  afterAll(async () => {
    await database?.db.$client.close();
  });

  it('persists passkeys and removes them with their user', async () => {
    const { db, schema } = database;

    const userId = 'passkey-user';
    await db.insert(schema.user).values({
      id: userId,
      name: 'Passkey User',
      email: 'passkey@example.test',
      emailVerified: true,
    });
    await db.insert(schema.passkey).values({
      id: 'passkey-1',
      name: 'Laptop',
      publicKey: 'public-key',
      userId,
      credentialID: 'credential-1',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'internal',
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
      aaguid: '00000000-0000-0000-0000-000000000000',
    });

    await expect(
      db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId)),
    ).resolves.toHaveLength(1);

    await db.delete(schema.user).where(eq(schema.user.id, userId));

    await expect(
      db.select().from(schema.passkey).where(eq(schema.passkey.userId, userId)),
    ).resolves.toEqual([]);
  });
});
