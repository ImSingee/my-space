import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  QueryAppDataTableRequest,
  QueryAppDataTableResponse,
  QueryAppKvResponse,
} from '~agent/protocol';
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
      { action: 'list' as const, limit: 10, revealSecrets: true },
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

describe('Platform REST App association client', () => {
  it('sends association and session-bound create requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/apps/mutable-slug')
        ? Response.json({ appId: 'canonical-app' })
        : Response.json({
            id: 'created-app',
            slug: 'created-app',
            name: 'Created App',
            files: [],
          });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createPlatformRestClient({
      baseUrl: 'http://platform.internal',
      token: 'runner-token',
    });

    await expect(
      client.associateSessionApp('session-one', 'mutable-slug'),
    ).resolves.toEqual({ appId: 'canonical-app' });
    await client.createApp(
      { slug: 'created-app', name: 'Created App' },
      'session-one',
    );

    expect(fetchMock.mock.calls).toEqual([
      [
        'http://platform.internal/internal/api/agent-sessions/session-one/apps/mutable-slug',
        {
          method: 'POST',
          headers: { authorization: 'Bearer runner-token' },
        },
      ],
      [
        'http://platform.internal/internal/api/apps',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer runner-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            slug: 'created-app',
            name: 'Created App',
            sessionId: 'session-one',
          }),
        },
      ],
    ]);
  });
});

describe('Platform REST Data Table client', () => {
  it('sends every action to the bearer-authenticated endpoint', async () => {
    const responses: QueryAppDataTableResponse[] = [
      { action: 'inspect', data: null },
      {
        action: 'query',
        items: [],
        cursor: null,
        revision: 0,
        truncated: false,
      },
      { action: 'mutate', results: [], revision: 1 },
      {
        action: 'raw_sql',
        results: [{ command: 'SELECT', count: 1, rows: [{ answer: 42 }] }],
        truncated: false,
      },
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
      { action: 'inspect' as const, table: 'todos' },
      {
        action: 'query' as const,
        table: 'todos',
        where: [{ field: 'done', op: 'eq' as const, value: false }],
        limit: 10,
      },
      {
        action: 'mutate' as const,
        operations: [{ type: 'delete' as const, table: 'todos', id: 'todo-1' }],
      },
      {
        action: 'raw_sql' as const,
        sql: 'select count(*) from data.todos',
        timeoutMs: 120_000,
      },
    ] satisfies QueryAppDataTableRequest[];

    for (const input of inputs) {
      await client.queryAppDataTable('demo-app', input);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[0]).toBe(
        'http://platform.internal/internal/api/apps/demo-app/query-data-table',
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

  it('forwards the caller abort signal', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        action: 'raw_sql',
        results: [],
        truncated: false,
      } satisfies QueryAppDataTableResponse),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createPlatformRestClient({
      baseUrl: 'http://platform.internal',
      token: 'runner-token',
    });
    const abort = new AbortController();

    await client.queryAppDataTable(
      'demo-app',
      { action: 'raw_sql', sql: 'select pg_sleep(1)' },
      abort.signal,
    );

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(abort.signal);
  });
});
