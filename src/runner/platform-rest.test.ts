import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryAppKvResponse } from '~agent/protocol';
import { createPlatformRestClient } from './platform-rest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Platform REST KV client', () => {
  it('sends every action to the bearer-authenticated query-kv endpoint', async () => {
    const responses: QueryAppKvResponse[] = [
      { action: 'list', items: [], nextCursor: null },
      { action: 'get', record: null },
      {
        action: 'set',
        record: {
          key: 'mode',
          value: 'production',
          secret: false,
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
      },
      { action: 'delete', ok: true },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      return Response.json(response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createPlatformRestClient({
      baseUrl: 'http://platform.internal',
      token: 'runner-token',
    });
    const inputs = [
      { action: 'list' as const, limit: 10 },
      { action: 'get' as const, key: 'missing' },
      {
        action: 'set' as const,
        key: 'mode',
        value: 'production',
        secret: false,
      },
      { action: 'delete' as const, key: 'mode' },
    ];

    for (const input of inputs) {
      await client.queryAppKv('demo-app', input);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[0]).toBe(
        'http://platform.internal/internal/api/apps/demo-app/query-kv',
      );
      expect(call[1]).toMatchObject({
        method: 'POST',
        headers: {
          authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(inputs[index]),
      });
    }
  });
});
