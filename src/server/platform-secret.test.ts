import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePlatformSecrets } from './platform-secret';

beforeEach(() => {
  // Stub both keys before the helper writes the fallback so Vitest can restore
  // the original process environment after every test.
  vi.stubEnv('SECRET', undefined);
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolvePlatformSecrets', () => {
  it.each([undefined, '', '   '])('requires SECRET when it is %s', (secret) => {
    vi.stubEnv('SECRET', secret);
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-only-secret');

    expect(() => resolvePlatformSecrets()).toThrow('SECRET is not set');
  });

  it.each([undefined, '', '   '])(
    'uses SECRET when BETTER_AUTH_SECRET is %s',
    (authSecret) => {
      vi.stubEnv('SECRET', 'platform-secret');
      vi.stubEnv('BETTER_AUTH_SECRET', authSecret);

      expect(resolvePlatformSecrets()).toEqual({
        secret: 'platform-secret',
        betterAuthSecret: 'platform-secret',
      });
      expect(process.env.BETTER_AUTH_SECRET).toBe('platform-secret');
    },
  );

  it('preserves an explicitly configured Better Auth secret', () => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');

    expect(resolvePlatformSecrets()).toEqual({
      secret: 'platform-secret',
      betterAuthSecret: 'auth-secret',
    });
    expect(process.env.BETTER_AUTH_SECRET).toBe('auth-secret');
  });
});
