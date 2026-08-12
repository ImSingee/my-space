import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataChange } from './realtime';

type Listen = (
  channel: string,
  onnotify: (payload: string) => void,
  onlisten?: () => void,
) => Promise<{ unlisten: () => Promise<void> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn<(text: string) => Promise<unknown[]>>(),
  accessCheck: vi.fn<(...args: unknown[]) => Promise<void>>(),
  guard: vi.fn<(...args: unknown[]) => Promise<void>>(),
  listen: vi.fn<Listen>(),
  unlisten: vi.fn<() => Promise<void>>(),
  end: vi.fn<() => Promise<void>>(),
  resolveUrl: vi.fn<(id: string) => Promise<string>>(),
  onnotify: undefined as ((payload: string) => void) | undefined,
  onlisten: undefined as (() => void) | undefined,
}));

vi.mock('postgres', () => ({
  default: vi.fn<(url: string) => unknown>(() => {
    const sql = (strings: TemplateStringsArray) =>
      mocks.query(strings.join(' '));
    return Object.assign(sql, {
      begin: async (...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== 'function') {
          throw new TypeError('Transaction callback is missing');
        }
        return callback(sql);
      },
      listen: mocks.listen,
      end: mocks.end,
    });
  }),
}));

vi.mock('./provision', () => ({
  resolveAppDataDatabaseUrl: mocks.resolveUrl,
}));
vi.mock('./service', () => ({
  acquireDataReadGuard: mocks.guard,
  assertDataTableAccess: mocks.accessCheck,
}));

import { AppError } from '~server/errors';
import postgres from 'postgres';
import { closeDataRealtime, subscribeDataChanges } from './realtime';

type RealtimeGlobal = typeof globalThis & {
  __hatchDataRealtime?: unknown;
};

const change = {
  seq: 1,
  table_name: 'todos',
  row_id: 'todo-1',
  operation: 'insert',
  created_at: new Date('2026-07-13T00:00:00.000Z'),
};

describe('managed Data Table realtime replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as RealtimeGlobal).__hatchDataRealtime;
    mocks.accessCheck.mockResolvedValue();
    mocks.guard.mockResolvedValue();
    mocks.unlisten.mockResolvedValue();
    mocks.end.mockResolvedValue();
    mocks.resolveUrl.mockResolvedValue(
      'postgres://data:old@127.0.0.1:5432/data',
    );
    mocks.listen.mockImplementation(
      async (
        _channel: string,
        onnotify: (payload: string) => void,
        onlisten?: () => void,
      ) => {
        mocks.onnotify = onnotify;
        mocks.onlisten = onlisten;
        onlisten?.();
        return { unlisten: mocks.unlisten };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays durable changes whenever LISTEN reconnects', async () => {
    const send = vi.fn<(event: unknown) => void>();
    mocks.query
      .mockResolvedValueOnce([{ min: 0, max: 0 }])
      .mockResolvedValueOnce([]);
    const unsubscribe = await subscribeDataChanges({
      id: 'app-1',
      since: 0,
      send,
    });
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));

    mocks.query
      .mockResolvedValueOnce([{ min: 1, max: 1 }])
      .mockResolvedValueOnce([change]);
    mocks.onlisten?.();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        seq: 1,
        table: 'todos',
        rowId: 'todo-1',
        operation: 'insert',
        createdAt: '2026-07-13T00:00:00.000Z',
      }),
    );
    unsubscribe();
  });

  it.each([
    ['retention gap', 3, { min: 5, max: 9 }],
    ['future cursor', 99, { min: 1, max: 9 }],
  ])('resets a subscriber after a %s', async (_name, since, range) => {
    const send = vi.fn<(event: unknown) => void>();
    mocks.query.mockResolvedValueOnce([range]);

    const unsubscribe = await subscribeDataChanges({
      id: `app-reset-${since}`,
      since,
      send,
    });

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ reset: true, seq: 9 }),
    );
    expect(mocks.query).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('replays bigint revisions above the PostgreSQL int4 range', async () => {
    const send = vi.fn<(event: unknown) => void>();
    mocks.query
      .mockResolvedValueOnce([{ min: '2147483648', max: '2147483648' }])
      .mockResolvedValueOnce([{ ...change, seq: '2147483648' }]);

    const unsubscribe = await subscribeDataChanges({
      id: 'app-bigint-revision',
      since: 2_147_483_647,
      send,
    });

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ seq: 2_147_483_648 }),
      ),
    );
    expect(mocks.query.mock.calls[0]?.[0]).toContain('::text as min');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('seq::text');
    unsubscribe();
  });

  it('coalesces notification bursts while a replay is active', async () => {
    let resolveFirstQuery:
      | ((rows: Array<{ min: number; max: number }>) => void)
      | undefined;
    mocks.query
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstQuery = resolve;
          }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ min: 0, max: 0 }])
      .mockResolvedValueOnce([]);

    const unsubscribe = await subscribeDataChanges({
      id: 'app-notify-burst',
      since: 0,
      send: vi.fn<(event: unknown) => void>(),
    });
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledOnce());

    for (let index = 0; index < 100; index += 1) {
      mocks.onnotify?.(String(index));
    }
    resolveFirstQuery?.([{ min: 0, max: 0 }]);

    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.query).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it('releases the migration guard between replay batches', async () => {
    const firstBatch = Array.from({ length: 1000 }, (_, index) => ({
      ...change,
      seq: index + 1,
      row_id: `todo-${index + 1}`,
    }));
    const finalChange = { ...change, seq: 1001, row_id: 'todo-1001' };
    const send = vi.fn<(event: unknown) => void>();
    mocks.query
      .mockResolvedValueOnce([{ min: 1, max: 1001 }])
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([{ min: 1, max: 1001 }])
      .mockResolvedValueOnce([finalChange]);

    const unsubscribe = await subscribeDataChanges({
      id: 'app-batched-replay',
      since: 0,
      send,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1001));
    expect(mocks.guard).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it('retries a failed pump without another notification', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn<(event: unknown) => void>();
    mocks.query
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce([{ min: 1, max: 1 }])
      .mockResolvedValueOnce([change]);

    const unsubscribe = await subscribeDataChanges({
      id: 'app-2',
      since: 0,
      send,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    unsubscribe();
    error.mockRestore();
  });

  it('cancels a pending pump retry after the final unsubscribe', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.query.mockRejectedValueOnce(new Error('connection lost'));

    const unsubscribe = await subscribeDataChanges({
      id: 'app-3',
      since: 0,
      send: vi.fn<(event: unknown) => void>(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('guards each replay and closes a stream once its deployment is stale', async () => {
    vi.useFakeTimers();
    const close = vi.fn<(error: unknown) => void>();
    mocks.guard.mockRejectedValueOnce(
      new AppError('Data Table client is stale.', 409),
    );

    await subscribeDataChanges({
      id: 'app-4',
      since: 7,
      expectedDeploymentId: 'deployment-v1',
      send: vi.fn<(event: unknown) => void>(),
      close,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.guard).toHaveBeenCalledWith(expect.any(Function), 'app-4', {
      expectedDeploymentId: 'deployment-v1',
    });
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ status: 409 }),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a stream instead of retrying through an activation fence', async () => {
    vi.useFakeTimers();
    const close = vi.fn<(error: unknown) => void>();
    mocks.guard.mockRejectedValueOnce(
      new AppError('Data Table deployment is being finalized.', 503),
    );

    await subscribeDataChanges({
      id: 'app-5',
      since: 7,
      expectedDeploymentId: 'deployment-v1',
      send: vi.fn<(event: unknown) => void>(),
      close,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503 }),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects from platform state before touching a deleted Data database', async () => {
    vi.useFakeTimers();
    mocks.accessCheck.mockRejectedValueOnce(
      new AppError('Data Table is not available.', 404),
    );

    await expect(
      subscribeDataChanges({
        id: 'app-deleted',
        since: 0,
        expectedDeploymentId: 'deployment-v1',
        send: vi.fn<(event: unknown) => void>(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits listener cleanup and closes every local subscriber', async () => {
    const firstClose = vi.fn<(error: unknown) => void>();
    const secondClose = vi.fn<(error: unknown) => void>();
    mocks.query.mockResolvedValue([]);

    await subscribeDataChanges({
      id: 'app-6',
      since: 0,
      send: vi.fn<(event: DataChange | { reset: true; seq: number }) => void>(),
      close: firstClose,
    });
    await subscribeDataChanges({
      id: 'app-6',
      since: 0,
      send: vi.fn<(event: DataChange | { reset: true; seq: number }) => void>(),
      close: secondClose,
    });

    await closeDataRealtime('app-6');

    expect(firstClose).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
    );
    expect(secondClose).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
    );
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('recreates a cached hub after database credentials rotate', async () => {
    const oldClose = vi.fn<(error: unknown) => void>();
    mocks.query.mockResolvedValue([]);

    const unsubscribeOld = await subscribeDataChanges({
      id: 'app-recreated',
      since: 0,
      send: vi.fn<(event: unknown) => void>(),
      close: oldClose,
    });
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));

    mocks.resolveUrl.mockResolvedValue(
      'postgres://data:new@127.0.0.1:5432/data',
    );
    const unsubscribeNew = await subscribeDataChanges({
      id: 'app-recreated',
      since: 0,
      send: vi.fn<(event: unknown) => void>(),
    });

    expect(postgres).toHaveBeenNthCalledWith(
      1,
      'postgres://data:old@127.0.0.1:5432/data',
      { max: 2 },
    );
    expect(postgres).toHaveBeenNthCalledWith(
      2,
      'postgres://data:new@127.0.0.1:5432/data',
      { max: 2 },
    );
    expect(oldClose).toHaveBeenCalledWith(
      expect.objectContaining({ status: 409 }),
    );
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();

    unsubscribeOld();
    unsubscribeNew();
    await vi.waitFor(() => expect(mocks.end).toHaveBeenCalledTimes(2));
  });

  it('does not attach a subscriber after deletion closes a pending hub', async () => {
    let resolveListen:
      | ((listener: { unlisten: () => Promise<void> }) => void)
      | undefined;
    mocks.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    );

    const subscription = subscribeDataChanges({
      id: 'app-racing-delete',
      since: 0,
      expectedDeploymentId: 'deployment-v1',
      send: vi.fn<(event: unknown) => void>(),
    });
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());

    const closing = closeDataRealtime('app-racing-delete');
    mocks.accessCheck.mockRejectedValue(
      new AppError('Data Table is not available.', 404),
    );
    resolveListen?.({ unlisten: mocks.unlisten });

    await expect(closing).resolves.toBeUndefined();
    await expect(subscription).rejects.toMatchObject({ status: 404 });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('closes the postgres client when the initial LISTEN fails', async () => {
    const failure = new Error('listen failed');
    mocks.listen.mockRejectedValue(failure);

    await expect(
      subscribeDataChanges({
        id: 'app-listen-failure',
        since: 0,
        send: vi.fn<(event: unknown) => void>(),
      }),
    ).rejects.toBe(failure);

    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
