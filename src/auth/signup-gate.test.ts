import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { assertSignupAllowed } = await import('~auth/signup-gate');
const { setPlatformConfig } = await import('~server/platform-config');

beforeEach(async () => {
  await db.delete(schema.platformConfig);
});

describe('assertSignupAllowed', () => {
  it('allows sign-up on a fresh install (no config row)', async () => {
    await expect(assertSignupAllowed()).resolves.toBeUndefined();
  });

  it('rejects with a Better Auth APIError once sign-up is turned off', async () => {
    await setPlatformConfig('auth.allowSignup', false);
    const failure = assertSignupAllowed();
    await expect(failure).rejects.toBeInstanceOf(APIError);
    await expect(failure).rejects.toThrow('Sign-up is currently disabled.');
  });

  it('applies a re-enable immediately (no restart involved)', async () => {
    await setPlatformConfig('auth.allowSignup', false);
    await expect(assertSignupAllowed()).rejects.toThrow(
      'Sign-up is currently disabled.',
    );

    await setPlatformConfig('auth.allowSignup', true);
    await expect(assertSignupAllowed()).resolves.toBeUndefined();
  });

  it('fails closed when the stored value is corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A corrupt row means someone had set the toggle; reopening sign-up
      // silently would be the worse failure, so the gate rejects.
      await db
        .insert(schema.platformConfig)
        .values({ key: 'auth.allowSignup', value: { nope: 1 } });

      await expect(assertSignupAllowed()).rejects.toThrow(
        'Sign-up is currently disabled.',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
