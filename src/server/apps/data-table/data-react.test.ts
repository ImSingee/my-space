import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  subscribeDataQueryCache,
  useDataQuery,
} from '../../../../packages/hatch-data/src/data-react';
import {
  createDataClient,
  DataRequestError,
  defineSchema,
  defineTable,
  t,
  type DataClient,
  type DataSchema,
} from '../../../../packages/hatch-data/src/data';

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn<(options: unknown) => Promise<unknown>>(),
  query: vi.fn<() => Promise<unknown>>(),
  setQueryData: vi.fn<(key: unknown, value: unknown) => void>(),
  stop: vi.fn<() => void>(),
  watch:
    vi.fn<
      (
        query: unknown,
        listener: (result: unknown) => void,
        onError?: (error: unknown) => void,
      ) => () => void
    >(),
}));

function client(): DataClient<DataSchema> {
  return {
    cacheNamespace: 'client-v1',
    query: mocks.query,
    watch: mocks.watch,
  } as unknown as DataClient<DataSchema>;
}

const queryClient = {
  fetchQuery: mocks.fetchQuery,
  setQueryData: mocks.setQueryData,
};

describe('managed Data Table React adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchQuery.mockResolvedValue(undefined);
  });

  it('uses watch snapshots as the query cache without another query', () => {
    const snapshot = { items: [], cursor: null, revision: 7 };
    mocks.watch.mockImplementation((_query, listener) => {
      listener(snapshot);
      return mocks.stop;
    });

    const stop = subscribeDataQueryCache(
      client(),
      { table: 'todos' },
      queryClient as never,
      ['hatch-data', 'client-v1', '{"table":"todos"}'],
    );

    expect(mocks.setQueryData).toHaveBeenCalledWith(
      ['hatch-data', 'client-v1', '{"table":"todos"}'],
      snapshot,
    );
    expect(mocks.query).not.toHaveBeenCalled();

    stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('preserves table-specific row types in useDataQuery', () => {
    const schema = defineSchema({
      todos: defineTable({ title: t.string() }),
      users: defineTable({ email: t.string() }),
    });

    const useTypeAssertions = () => {
      const typedClient = createDataClient<typeof schema>({ baseUrl: '/data' });
      const result = useDataQuery(typedClient, { table: 'todos' });
      const row = result.data?.items[0];
      const title: string | undefined = row?.title;
      // @ts-expect-error Todo rows do not include fields from other tables.
      const email = row?.email;
      // @ts-expect-error Table names are restricted to the schema.
      useDataQuery(typedClient, { table: 'missing' });
      return { email, title };
    };

    expect(useTypeAssertions).toBeTypeOf('function');
  });

  it('surfaces permanent watch failures through the Query state', async () => {
    const transient = new DataRequestError('temporarily unavailable', 503);
    const permanent = new DataRequestError('inactive deployment', 409);
    mocks.watch.mockImplementation((_query, _listener, onError) => {
      onError?.(transient);
      onError?.(permanent);
      return mocks.stop;
    });

    subscribeDataQueryCache(
      client(),
      { table: 'todos' },
      queryClient as never,
      ['hatch-data', 'client-v1', '{"table":"todos"}'],
    );

    expect(mocks.fetchQuery).toHaveBeenCalledOnce();
    const options = mocks.fetchQuery.mock.calls[0]?.[0] as {
      queryFn: () => Promise<unknown>;
      retry: boolean;
      staleTime: number;
    };
    expect(options.retry).toBe(false);
    expect(options.staleTime).toBe(0);
    await expect(options.queryFn()).rejects.toBe(permanent);
  });

  it('moves a fresh Query cache entry into the error state', async () => {
    const key = ['hatch-data', 'client-v1', '{"table":"todos"}'] as const;
    const permanent = new DataRequestError('inactive deployment', 409);
    const realQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    realQueryClient.setQueryData(key, {
      items: [],
      cursor: null,
      revision: 7,
    });
    mocks.watch.mockImplementation((_query, _listener, onError) => {
      onError?.(permanent);
      return mocks.stop;
    });

    subscribeDataQueryCache(
      client(),
      { table: 'todos' },
      realQueryClient as never,
      key,
    );

    await vi.waitFor(() =>
      expect(realQueryClient.getQueryState(key)).toMatchObject({
        status: 'error',
        error: permanent,
      }),
    );
    realQueryClient.clear();
  });
});
