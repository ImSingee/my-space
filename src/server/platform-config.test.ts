import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { getPlatformConfig, setPlatformConfig } =
  await import('~server/platform-config');

beforeEach(async () => {
  await db.delete(schema.platformConfig);
  await db.delete(schema.user);
});

describe('getPlatformConfig', () => {
  it('returns the default when no row exists (fresh install)', async () => {
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(true);
  });

  it('round-trips values through setPlatformConfig (insert then update)', async () => {
    await setPlatformConfig('auth.allowSignup', false);
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(false);

    // Second write hits the upsert's conflict path.
    await setPlatformConfig('auth.allowSignup', true);
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(true);

    const rows = await db.select().from(schema.platformConfig);
    expect(rows).toHaveLength(1);
  });

  it('uses the invalid-value fallback when the stored value fails validation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Bypass the typed writer to simulate a corrupt/legacy row. Unlike a
      // missing row (fresh install => sign-up open), a corrupt row fails
      // closed: `auth.allowSignup` declares `invalidFallback: false`.
      await db
        .insert(schema.platformConfig)
        .values({ key: 'auth.allowSignup', value: 'definitely' });

      await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
