import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { removePlatformUser } = await import('~server/users-store');

async function seedUser(id: string) {
  await db.insert(schema.user).values({
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
  });
}

async function seedSessionAndAccount(userId: string) {
  await db.insert(schema.session).values({
    id: `session-${userId}`,
    token: `token-${userId}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    userId,
  });
  await db.insert(schema.account).values({
    id: `account-${userId}`,
    accountId: userId,
    providerId: 'credential',
    userId,
    password: 'hashed-password',
  });
}

beforeEach(async () => {
  // user cascades into session and account rows.
  await db.delete(schema.user);
});

describe('removePlatformUser', () => {
  it('rejects deleting the account you are signed in with', async () => {
    await seedUser('u1');
    await seedUser('u2');

    await expect(removePlatformUser('u1', 'u1')).rejects.toThrow(
      'You cannot delete the account you are signed in with.',
    );
    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(2);
  });

  it('rejects deleting the last remaining user', async () => {
    await seedUser('u1');

    // Backstop path: a caller identity that is not the target while only one
    // user row exists.
    await expect(removePlatformUser('u1', 'someone-else')).rejects.toThrow(
      'The last user cannot be deleted.',
    );
    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(1);
  });

  it('rejects deleting a user that does not exist', async () => {
    await seedUser('u1');

    await expect(removePlatformUser('missing', 'u1')).rejects.toThrow(
      'User not found.',
    );
  });

  it('deletes another user and cascades their sessions and accounts', async () => {
    await seedUser('u1');
    await seedUser('u2');
    await seedSessionAndAccount('u2');

    await expect(removePlatformUser('u2', 'u1')).resolves.toBeUndefined();

    const users = await db.select().from(schema.user);
    expect(users.map((u) => u.id)).toEqual(['u1']);
    await expect(db.select().from(schema.session)).resolves.toHaveLength(0);
    await expect(db.select().from(schema.account)).resolves.toHaveLength(0);
  });
});
