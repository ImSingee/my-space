import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('~auth/server', () => ({
  auth: { api: { getSession: vi.fn<() => unknown>() } },
}));
vi.mock('~/db', () => ({ db: {}, schema: {} }));
import { openAppAccess, safeAppReturnPath, sealAppAccess } from './app-access';

beforeEach(() => {
  vi.stubEnv('SECRET', 'app-access-boundary-test-secret-32bytes');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:3700');
  vi.stubEnv('DATABASE_URL', 'postgres://fixture:fixture@127.0.0.1:1/fixture');
});
describe('App-origin session envelope boundary', () => {
  it('does not let one App session authenticate another App, origin, binding revision or purpose', () => {
    const binding = {
      appId: 'app-a',
      origin: 'https://notes.example.ts.net',
      revision: 'one',
    };
    const cookie = sealAppAccess(binding, 'session', {
      sessionId: 'parent-id',
    });
    expect(openAppAccess(binding, 'session', cookie)).toEqual({
      sessionId: 'parent-id',
    });
    for (const other of [
      { ...binding, appId: 'app-b' },
      { ...binding, origin: 'https://other.example.ts.net' },
      { ...binding, revision: 'two' },
    ]) {
      expect(() => openAppAccess(other, 'session', cookie)).toThrow(
        /App access/,
      );
    }
    expect(() => openAppAccess(binding, 'login', cookie)).toThrow(/App access/);
    expect(() =>
      openAppAccess(binding, 'session', cookie.slice(0, -1)),
    ).toThrow(/App access/);
  });
  it('only restores local application paths, retaining query and fragment', () => {
    expect(safeAppReturnPath('/tasks?filter=open#today')).toBe(
      '/tasks?filter=open#today',
    );
    for (const path of [
      'https://evil.test/',
      '//evil.test/',
      '/\\evil.test/',
      '/__hatch/auth/start',
      '/\n/evil.test',
    ])
      expect(safeAppReturnPath(path)).toBeNull();
  });
});
