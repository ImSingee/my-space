import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn<(options: unknown) => unknown>((options) => options),
  drizzleAdapter: vi.fn<(database: unknown, options: unknown) => string>(
    () => 'database-adapter',
  ),
  tanstackStartCookies: vi.fn<() => string>(() => 'tanstack-start-cookies'),
}));

vi.mock('better-auth/minimal', () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: mocks.tanstackStartCookies,
}));

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('./signup-gate', () => ({
  assertSignupAllowed: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

describe('Better Auth configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');
    vi.stubEnv('APP_URL', '  https://app.example.test:8443/  ');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the normalized APP_URL as its base URL', async () => {
    await import('./server');

    expect(mocks.betterAuth).toHaveBeenCalledOnce();
    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://app.example.test:8443',
        secret: 'auth-secret',
      }),
    );
  });
});
