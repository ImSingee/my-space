import { expect, it, vi } from 'vitest';
const getSession = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('~auth/server', () => ({ auth: { api: { getSession } } }));
import {
  authorizeAppRuntimeRequest,
  markAppRuntimeRequest,
} from './runtime-auth';
it('App scope cannot fall back to a supplied platform cookie or another App identity', async () => {
  getSession.mockResolvedValue({ user: { id: 'owner' } });
  const request = new Request(
    'https://notes.example.ts.net/api/app/a/rpc/ping',
    { method: 'POST' },
  );
  markAppRuntimeRequest(request, 'a', true);
  expect(await authorizeAppRuntimeRequest(request, 'a')).toBe(true);
  expect(await authorizeAppRuntimeRequest(request, 'b')).toBe(false);
  markAppRuntimeRequest(request, 'a', false);
  expect(await authorizeAppRuntimeRequest(request, 'a')).toBe(false);
  expect(getSession).not.toHaveBeenCalled();
});
it('requires the App origin for authenticated browser mutations', async () => {
  const request = new Request(
    'https://notes.example.ts.net/api/app/a/rpc/ping',
    { method: 'POST', headers: { origin: 'https://other.example.ts.net' } },
  );
  markAppRuntimeRequest(request, 'a', true);
  expect(await authorizeAppRuntimeRequest(request, 'a')).toBe(false);
});
