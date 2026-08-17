import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDataClient,
  DATA_DEPLOYMENT_HEADER,
  type DataField,
  DataRequestError,
  defineSchema,
  defineTable,
  t,
  type DataFields,
  type DataSchema,
  type DataInsert,
  type DataPatchOptions,
  type DataQuery,
  type DataQueryFor,
} from '../../../../packages/hatch-data/src/data';

describe('managed Data Table schema SDK', () => {
  it('allows indexes on platform-managed system fields', () => {
    const table = defineTable({ title: t.string() })
      .index('by_created', ['createdAt'])
      .uniqueIndex('by_id_and_updated', ['id', 'updatedAt']);

    expect(table.descriptor.indexes).toEqual([
      { name: 'by_created', fields: ['createdAt'], unique: false },
      {
        name: 'by_id_and_updated',
        fields: ['id', 'updatedAt'],
        unique: true,
      },
    ]);
  });

  it('only exposes defaultNow on datetime fields', () => {
    expect(t.datetime().defaultNow().descriptor.default).toEqual({
      $hatch: 'now',
    });

    expect(() => {
      // @ts-expect-error defaultNow is not valid for ordinary strings.
      t.string().defaultNow();
    }).toBeTypeOf('function');
  });

  it('preserves optional datetime values through defaultNow', () => {
    const publishedAt = t.datetime().optional().defaultNow();
    const table = defineTable({ publishedAt });
    const input: DataInsert<typeof table> = { publishedAt: null };

    expect(publishedAt.descriptor).toMatchObject({
      kind: 'datetime',
      optional: true,
      default: { $hatch: 'now' },
    });
    expect(input).toEqual({ publishedAt: null });
  });

  it('only permits optional fields in patch unset options', () => {
    const table = defineTable({
      title: t.string(),
      completed: t.boolean().default(false),
      note: t.string().optional(),
    });
    const options: DataPatchOptions<typeof table> = { unset: ['note'] };
    const invalidOptions = () => {
      const required: DataPatchOptions<typeof table> = {
        // @ts-expect-error required fields cannot be unset.
        unset: ['title'],
      };
      const defaulted: DataPatchOptions<typeof table> = {
        // @ts-expect-error defaults do not make a field nullable.
        unset: ['completed'],
      };
      return { required, defaulted };
    };

    expect(options).toEqual({ unset: ['note'] });
    expect(invalidOptions).toBeTypeOf('function');
  });

  it('keeps index selection out of the query contract', () => {
    const schema = defineSchema({
      todos: defineTable({
        title: t.string(),
        completed: t.boolean(),
      }).index('by_completed', ['completed']),
    });
    const query: DataQueryFor<typeof schema, 'todos'> = {
      table: 'todos',
      where: [{ field: 'completed', op: 'eq', value: false }],
      orderBy: { field: 'title', direction: 'asc' },
      limit: 25,
    };
    const client = createDataClient<typeof schema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });
    const validQuery = () => client.query(query);
    const invalidQueries = () => {
      const untypedSchemaQuery: DataQuery = {
        table: 'todos',
        // @ts-expect-error indexes are declared on tables, not selected by queries.
        index: 'by_completed',
      };
      const schemaQuery: DataQueryFor<typeof schema, 'todos'> = {
        table: 'todos',
        // @ts-expect-error indexes are declared on tables, not selected by queries.
        index: 'by_completed',
      };
      client.query({
        table: 'todos',
        // @ts-expect-error indexes are declared on tables, not selected by queries.
        index: 'by_completed',
      });
      return { untypedSchemaQuery, schemaQuery };
    };

    expect(query).toEqual({
      table: 'todos',
      where: [{ field: 'completed', op: 'eq', value: false }],
      orderBy: { field: 'title', direction: 'asc' },
      limit: 25,
    });
    expect(validQuery).toBeTypeOf('function');
    expect(invalidQueries).toBeTypeOf('function');
  });

  it('rejects defaults that the deployment validator cannot accept', () => {
    const widenedFields: DataFields = { owner: t.ref('users') };
    const widenedString: DataField<
      unknown,
      { optional: true; hasDefault: false },
      'string'
    > = t.string().optional();
    const mixedKind = null as unknown as DataField<
      string | null,
      { optional: true; hasDefault: false },
      'string' | 'json'
    >;
    const undeployableDefaults = () => {
      // @ts-expect-error reference fields cannot declare defaults.
      t.ref('users').default('user-id');
      // @ts-expect-error optionality does not make null a valid string default.
      t.string().optional().default(null);
      // @ts-expect-error optional references still cannot declare defaults.
      t.ref('users').optional().default(null);
      // @ts-expect-error widening must not make reference defaults callable.
      widenedFields.owner.default('user-id');
      // @ts-expect-error widening TValue must not make null a scalar default.
      widenedString.default(null);
      // @ts-expect-error field kind still requires a string after TValue widens.
      widenedString.default({});
      // @ts-expect-error only an exact JSON kind may retain null defaults.
      mixedKind.default(null);
    };

    expect(undeployableDefaults).toBeTypeOf('function');
    expect(t.string().optional().default('untitled').descriptor.default).toBe(
      'untitled',
    );
    expect(widenedString.default('untitled').descriptor.default).toBe(
      'untitled',
    );
    expect(t.json().optional().default(null).descriptor.default).toBeNull();
    expect(t.json().default({ $hatch: 'now' }).descriptor.default).toEqual({
      $hatch: 'now',
    });
  });
});

describe('managed Data Table SDK deployment binding', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends an explicit deployment id with every request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [], cursor: null, revision: 0 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });

    await client.query({ table: 'todos' });

    expect(fetch).toHaveBeenCalledWith(
      'https://hatch.test/api/app/example/data/query',
      expect.objectContaining({
        headers: expect.objectContaining({
          [DATA_DEPLOYMENT_HEADER]: 'deployment-v2',
        }),
      }),
    );
  });

  it('sends optional fields to unset with a patch mutation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ results: [{ id: 'row-1', note: null }], revision: 1 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });

    await client.patch('todos', 'row-1', {}, { unset: ['note'] });

    const request = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      operations: [
        {
          type: 'patch',
          table: 'todos',
          id: 'row-1',
          value: {},
          unset: ['note'],
        },
      ],
    });
  });

  it('sends atomic increments only for required numeric fields', async () => {
    const schema = defineSchema({
      metrics: defineTable({
        count: t.integer(),
        ratio: t.number().default(0),
        optionalCount: t.integer().optional(),
        label: t.string(),
      }),
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        results: [{ id: 'row-1', count: 3 }],
        revision: 1,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<typeof schema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });

    await client.increment('metrics', 'row-1', 'count', 2);

    const request = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      operations: [
        {
          type: 'increment',
          table: 'metrics',
          id: 'row-1',
          field: 'count',
          amount: 2,
        },
      ],
    });

    const typeErrors = () => {
      client.increment('metrics', 'row-1', 'ratio', 0.5);
      // @ts-expect-error optional numeric fields cannot be incremented.
      client.increment('metrics', 'row-1', 'optionalCount', 1);
      // @ts-expect-error non-numeric fields cannot be incremented.
      client.increment('metrics', 'row-1', 'label', 1);
    };
    expect(typeErrors).toBeTypeOf('function');
  });

  it('isolates framework caches by endpoint and deployment', () => {
    const first = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/first/data/',
      deploymentId: 'deployment-v1',
    });
    const second = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/second/data',
      deploymentId: 'deployment-v1',
    });
    const redeployed = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/first/data',
      deploymentId: 'deployment-v2',
    });

    expect(first.cacheNamespace).not.toBe(second.cacheNamespace);
    expect(first.cacheNamespace).not.toBe(redeployed.cacheNamespace);
    expect(first.cacheNamespace).toBe(
      createDataClient<DataSchema>({
        baseUrl: 'https://hatch.test/api/app/first/data',
        deploymentId: 'deployment-v1',
      }).cacheNamespace,
    );
  });

  it('uses the deployment id injected into a backend environment', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ items: [], cursor: null, revision: 0 }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('Deno', {
      env: {
        get: (name: string) =>
          name === 'HATCH_DEPLOYMENT_ID' ? 'deployment-backend' : undefined,
      },
    });
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
    });

    await client.query({ table: 'todos' });

    expect(fetch).toHaveBeenCalledWith(
      'https://hatch.test/api/app/example/data/query',
      expect.objectContaining({
        headers: expect.objectContaining({
          [DATA_DEPLOYMENT_HEADER]: 'deployment-backend',
        }),
      }),
    );
  });

  it('waits for the initial query retry before opening a realtime stream', async () => {
    vi.useFakeTimers();
    let queryAttempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/query')) {
        queryAttempts += 1;
        if (queryAttempts === 1) {
          return new Response('temporarily unavailable', { status: 503 });
        }
        return Response.json({ items: [], cursor: null, revision: 0 });
      }
      return new Response('');
    });
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });
    const stop = client.watch({ table: 'todos' }, () => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/query$/);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[1]?.[0])).toMatch(/\/query$/);
    expect(String(fetch.mock.calls[2]?.[0])).toContain('/events?');
    stop();
  });

  it('suppresses an in-flight query after the watcher stops', async () => {
    let resolveQuery: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      if (!String(input).endsWith('/query')) {
        throw new Error('Watcher opened a realtime stream after it stopped.');
      }
      return new Promise<Response>((resolve) => {
        resolveQuery = resolve;
      });
    });
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });
    const listener = vi.fn<(result: unknown) => void>();
    const onError = vi.fn<(error: unknown) => void>();

    const stop = client.watch({ table: 'todos' }, listener, onError);
    expect(fetch).toHaveBeenCalledOnce();
    const querySignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(querySignal).toBeInstanceOf(AbortSignal);

    stop();
    expect(querySignal?.aborted).toBe(true);
    resolveQuery?.(Response.json({ items: [], cursor: null, revision: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves HTTP status and stops watching after a permanent query error', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('inactive deployment', { status: 409 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v1',
    });
    const onError = vi.fn<(error: unknown) => void>();

    const stop = client.watch({ table: 'todos' }, () => {}, onError);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetch).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'DataRequestError',
        message: 'inactive deployment',
        status: 409,
      }),
    );
    stop();
  });

  it('stops reconnecting after a permanent realtime error', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith('/query')
        ? Response.json({ items: [], cursor: null, revision: 0 })
        : new Response('App not found', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v1',
    });
    const onError = vi.fn<(error: unknown) => void>();

    const stop = client.watch({ table: 'todos' }, () => {}, onError);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
    );
    stop();
  });

  it('exposes status on ordinary request failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(
        async () => new Response('bad query', { status: 400 }),
      ),
    );
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });

    await expect(client.query({ table: 'todos' })).rejects.toEqual(
      expect.objectContaining<DataRequestError>({
        name: 'DataRequestError',
        message: 'bad query',
        status: 400,
      }),
    );
  });

  it('backs off before reconnecting after a clean realtime EOF', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      return url.endsWith('/query')
        ? Response.json({ items: [], cursor: null, revision: 0 })
        : new Response('');
    });
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });
    const stop = client.watch({ table: 'todos' }, () => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    stop();
  });

  it('refreshes snapshots during sustained realtime events', async () => {
    vi.useFakeTimers();
    let queryCount = 0;
    let closeStream = () => {};
    const encoder = new TextEncoder();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/query')) {
        queryCount += 1;
        return Response.json({
          items: [],
          cursor: null,
          revision: queryCount,
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let eventRevision = 1;
          const interval = setInterval(() => {
            controller.enqueue(
              encoder.encode(
                `id: ${eventRevision}\nevent: change\ndata: {}\n\n`,
              ),
            );
            eventRevision += 1;
          }, 20);
          closeStream = () => {
            clearInterval(interval);
            controller.close();
          };
        },
      });
      return new Response(body);
    });
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });
    const listener = vi.fn<(result: unknown) => void>();

    const stop = client.watch({ table: 'todos' }, listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledOnce();

    // Events arrive every 20 ms, so a trailing-only 30 ms debounce never fires.
    // The watcher must still publish snapshots while the stream remains busy.
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.mock.calls.length).toBeGreaterThan(1);

    closeStream();
    stop();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('reconnects from the lower revision carried by a reset event', async () => {
    vi.useFakeTimers();
    let queryCount = 0;
    let streamCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/query')) {
        queryCount += 1;
        return Response.json({
          items: [],
          cursor: null,
          revision: queryCount === 1 ? 10 : 3,
        });
      }
      streamCount += 1;
      return streamCount === 1
        ? new Response('id: 3\nevent: reset\ndata: {"reset":true}\n\n')
        : new Response('inactive deployment', { status: 409 });
    });
    vi.stubGlobal('fetch', fetch);
    const client = createDataClient<DataSchema>({
      baseUrl: 'https://hatch.test/api/app/example/data',
      deploymentId: 'deployment-v2',
    });

    const stop = client.watch({ table: 'todos' }, () => {});
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(970);

    const streamUrls = fetch.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/events?'));
    expect(streamUrls).toEqual([
      expect.stringContaining('since=10'),
      expect.stringContaining('since=3'),
    ]);
    stop();
  });
});
