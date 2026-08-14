import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvEntry } from '~agent/protocol';
import { AppError } from '~server/errors';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(input: { headers: Headers }) => Promise<unknown>>(),
  submitAgentEnv:
    vi.fn<
      (runId: string, requestId: string, entries: EnvEntry[]) => Promise<void>
    >(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock('~server/agent-runs', () => ({
  submitAgentEnv: mocks.submitAgentEnv,
}));

const { postAgentRunEnv } = await import('./env');

function envRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/runs/run-1/env', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.submitAgentEnv.mockResolvedValue(undefined);
});

describe('POST /api/agent/runs/:runId/env', () => {
  it('forwards the exact transient entries and disables caching', async () => {
    const entries = [
      { key: 'SERVICE_TOKEN', value: 'plaintext-canary', secret: true },
      { key: 'ACCOUNT_ID', value: 'account-1', secret: false },
      { key: 'EMPTY_VALUE', value: '', secret: true },
      { key: 'ALL_QUOTES', value: 'a\'"`b', secret: false },
    ];
    const response = await postAgentRunEnv({
      request: envRequest({ requestId: 'secret-1', entries }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.submitAgentEnv).toHaveBeenCalledOnce();
    expect(mocks.submitAgentEnv).toHaveBeenCalledWith(
      'run-1',
      'secret-1',
      entries,
    );
  });

  it('rejects unauthenticated and malformed submissions with no-store', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const unauthorized = await postAgentRunEnv({
      request: envRequest({ requestId: 'secret-1', entries: [] }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');

    for (const body of [
      {
        requestId: 'secret-1',
        entries: [
          { key: 'TOKEN', value: 'value', secret: true, plaintext: 'extra' },
        ],
      },
      {
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: 'line one\nline two', secret: true }],
      },
      {
        requestId: 'secret-1',
        entries: [
          { key: 'TOKEN', value: 'first', secret: true },
          { key: 'TOKEN', value: 'second', secret: false },
        ],
      },
      {
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: '😀'.repeat(4097), secret: true }],
      },
      {
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: 'value' }],
      },
      {
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: 'value', secret: true }],
        extra: true,
      },
    ]) {
      const response = await postAgentRunEnv({
        request: envRequest(body),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.text()).resolves.toBe('Bad request');
    }
    expect(mocks.submitAgentEnv).not.toHaveBeenCalled();
  });

  it('requires JSON so cross-origin simple requests cannot submit values', async () => {
    const response = await postAgentRunEnv({
      request: new Request('http://localhost/api/agent/runs/run-1/env', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          requestId: 'secret-1',
          entries: [{ key: 'TOKEN', value: 'plaintext-canary', secret: true }],
        }),
      }),
    });

    expect(response.status).toBe(415);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('Unsupported media type');
    expect(mocks.submitAgentEnv).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 instead of replacing environment bytes', async () => {
    const response = await postAgentRunEnv({
      request: new Request('http://localhost/api/agent/runs/run-1/env', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([
          ...new TextEncoder().encode(
            '{"requestId":"secret-1","entries":[{"key":"TOKEN","value":"',
          ),
          0xff,
          ...new TextEncoder().encode('","secret":true}]}'),
        ]),
      }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('Bad request');
    expect(mocks.submitAgentEnv).not.toHaveBeenCalled();
  });

  it('keeps authentication failures fixed and non-cacheable', async () => {
    mocks.getSession.mockRejectedValueOnce(
      new Error('plaintext-canary-from-auth-error'),
    );
    const response = await postAgentRunEnv({
      request: envRequest({
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: 'value', secret: true }],
      }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe(
      'Could not submit environment values.',
    );
  });

  it('caps the raw request body before parsing JSON', async () => {
    const response = await postAgentRunEnv({
      request: envRequest({
        requestId: 'secret-1',
        entries: [
          { key: 'TOKEN', value: 'x'.repeat(256 * 1024), secret: true },
        ],
      }),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('Payload too large');
    expect(mocks.submitAgentEnv).not.toHaveBeenCalled();
  });

  it('maps service failures to endpoint-owned fixed responses', async () => {
    const cases = [
      [409, 'Environment request is no longer waiting.'],
      [502, 'Agent Runner could not store the environment.'],
      [503, 'Agent Runner is unavailable.'],
      [504, 'Agent Runner did not confirm environment storage.'],
    ] as const;
    for (const [status, expected] of cases) {
      mocks.submitAgentEnv.mockRejectedValueOnce(
        new AppError('plaintext-canary-from-internal-error', status),
      );
      const response = await postAgentRunEnv({
        request: envRequest({
          requestId: 'secret-1',
          entries: [{ key: 'TOKEN', value: 'value', secret: true }],
        }),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.text()).resolves.toBe(expected);
    }

    mocks.submitAgentEnv.mockRejectedValueOnce(
      new Error('plaintext-canary-from-unknown-error'),
    );
    const unknown = await postAgentRunEnv({
      request: envRequest({
        requestId: 'secret-1',
        entries: [{ key: 'TOKEN', value: 'value', secret: true }],
      }),
    });
    expect(unknown.status).toBe(500);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    await expect(unknown.text()).resolves.toBe(
      'Could not submit environment values.',
    );
  });
});
