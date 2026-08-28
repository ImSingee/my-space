import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(input: { headers: Headers }) => Promise<unknown>>(),
  startAgentRun: vi.fn<(input: unknown) => Promise<{ runId: string }>>(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock('~server/agent-runs', () => ({
  startAgentRun: mocks.startAgentRun,
}));

const { postAgentRun } = await import('./runs');

const baseBody = {
  sessionId: 'session-1',
  providerId: 'provider-1',
  modelId: 'model-1',
};

function runRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.startAgentRun.mockResolvedValue({ runId: 'run-1' });
});

describe('POST /api/agent/runs', () => {
  it.each([
    ['file', { attachmentIds: ['attachment-1'] }],
    [
      'image',
      {
        images: [
          {
            data: 'base64-image',
            mimeType: 'image/png',
          },
        ],
      },
    ],
  ])(
    'normalizes legacy userText with a %s attachment',
    async (_name, extra) => {
      const response = await postAgentRun({
        request: runRequest({
          ...baseBody,
          userText: 'Keep these instructions',
          ...extra,
        }),
      });

      expect(response.status).toBe(200);
      const forwarded = mocks.startAgentRun.mock.calls[0]?.[0];
      expect(forwarded).toEqual({
        ...baseBody,
        content: [{ type: 'text', text: 'Keep these instructions' }],
        ...extra,
      });
      expect(forwarded).not.toHaveProperty('userText');
    },
  );

  it('normalizes a text-only legacy request', async () => {
    const response = await postAgentRun({
      request: runRequest({
        ...baseBody,
        userText: 'Legacy instructions',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.startAgentRun).toHaveBeenCalledWith({
      ...baseBody,
      content: [{ type: 'text', text: 'Legacy instructions' }],
    });
  });

  it('rejects requests that mix userText with content', async () => {
    const response = await postAgentRun({
      request: runRequest({
        ...baseBody,
        userText: 'Legacy instructions',
        content: [{ type: 'text', text: 'Modern instructions' }],
        attachmentIds: ['attachment-1'],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Bad request');
    expect(mocks.startAgentRun).not.toHaveBeenCalled();
  });
});
