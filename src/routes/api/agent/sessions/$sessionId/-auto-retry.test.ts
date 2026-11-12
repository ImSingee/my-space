vi.mock('~server/tailscale-manager', () => ({
  getTailscaleManager: () => ({ trustedOrigin: () => null }),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(input: { headers: Headers }) => Promise<unknown>>(),
  stopAgentAutoRetry: vi.fn<(sessionId: string) => Promise<void>>(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock('~server/agent-runs', () => ({
  stopAgentAutoRetry: mocks.stopAgentAutoRetry,
}));

const { deleteAgentAutoRetry } = await import('./auto-retry');

function stopRequest(): Request {
  return new Request(
    'http://localhost/api/agent/sessions/session%201/auto-retry',
    { method: 'DELETE' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopAgentAutoRetry.mockResolvedValue();
});

describe('DELETE /api/agent/sessions/$sessionId/auto-retry', () => {
  it('stops the session automatic retry for a signed-in user', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await deleteAgentAutoRetry({ request: stopRequest() });

    expect(response.status).toBe(200);
    expect(mocks.stopAgentAutoRetry).toHaveBeenCalledExactlyOnceWith(
      'session 1',
    );
  });

  it('rejects unauthenticated requests', async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await deleteAgentAutoRetry({ request: stopRequest() });

    expect(response.status).toBe(401);
    expect(mocks.stopAgentAutoRetry).not.toHaveBeenCalled();
  });
});
