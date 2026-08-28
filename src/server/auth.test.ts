import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler: (handler: unknown) => handler,
  }),
  createServerOnlyFn: (handler: unknown) => handler,
  createMiddleware: () => ({
    server: (handler: unknown) => handler,
  }),
}));

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://hatch.example.test/dashboard'),
}));

vi.mock('~auth/server', () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
    },
  },
}));

import { hasActiveSession } from './auth';

describe('hasActiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only an authentication boolean for a valid session', async () => {
    const token = 'server-only-session-token';
    mocks.getSession.mockResolvedValue({
      session: { id: 'session-id', token },
      user: { id: 'user-id', email: 'owner@example.test' },
    });

    const result = await hasActiveSession();

    expect(result).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('returns false when the request has no session', async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(hasActiveSession()).resolves.toBe(false);
  });
});
