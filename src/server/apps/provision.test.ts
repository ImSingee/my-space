import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDatabaseUrl } from './provision';

beforeEach(() => {
  vi.stubEnv(
    'APP_DATABASE_URL',
    'postgres://admin:admin-password@db.example.test:5432/platform?sslmode=require',
  );
  vi.stubEnv('SECRET', 'platform-secret');
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('appDatabaseUrl', () => {
  it('derives the app role password from SECRET', () => {
    const url = new URL(appDatabaseUrl('demo-app'));

    expect(url.username).toBe('app_demo_app');
    expect(url.password).toBe(
      'b17c3d570aa35bad7791d0f103b212d562693ceb1271dc94687573fb4ff213a2',
    );
    expect(url.pathname).toBe('/app_demo_app');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });

  it('does not use BETTER_AUTH_SECRET for the app password', () => {
    const first = new URL(appDatabaseUrl('demo-app')).password;

    vi.stubEnv('BETTER_AUTH_SECRET', 'different-auth-secret');

    expect(new URL(appDatabaseUrl('demo-app')).password).toBe(first);
  });

  it('changes the app password when SECRET changes', () => {
    vi.stubEnv('SECRET', 'other-platform-secret');

    expect(new URL(appDatabaseUrl('demo-app')).password).toBe(
      '0e54cb2a4360155e2464bcf43657488ab724cbede7e416b668939e8c765ec710',
    );
  });

  it('does not fall back to BETTER_AUTH_SECRET for app passwords', () => {
    vi.stubEnv('SECRET', undefined);
    vi.stubEnv('BETTER_AUTH_SECRET', 'legacy-auth-secret');

    expect(() => appDatabaseUrl('demo-app')).toThrow('SECRET is not set');
  });
});
