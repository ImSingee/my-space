import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
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

  it('keeps sign-up closed for installs upgraded from HATCH_ALLOW_SIGNUP', async () => {
    // Re-run the seed statement from migration 0024 (createTestDb applied it
    // against an empty database, where it is a no-op) to check each upgrade
    // scenario against the very SQL production executes.
    const migrationSql = await readFile(
      path.resolve(import.meta.dirname, '../../migrations/0024_bumpy_klaw.sql'),
      'utf8',
    );
    const [, seedStatement] = migrationSql.split('--> statement-breakpoint');
    const runSeed = () => db.execute(sql.raw(seedStatement));

    // Fresh install (no users): no row is seeded, sign-up stays open for
    // bootstrapping the first account.
    await runSeed();
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(true);

    // Upgraded install (users exist): sign-up is seeded closed, matching the
    // removed HATCH_ALLOW_SIGNUP production default.
    await db.insert(schema.user).values({
      id: 'existing-user',
      name: 'Existing User',
      email: 'existing@example.com',
    });
    await runSeed();
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(false);

    // Re-running (e.g. a replayed migration) must not clobber an explicit
    // owner choice.
    await setPlatformConfig('auth.allowSignup', true);
    await runSeed();
    await expect(getPlatformConfig('auth.allowSignup')).resolves.toBe(true);
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
