import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = {
    unsafe: vi.fn<(statement: string) => Promise<{ answer: number }[]>>(
      async () => [{ answer: 42 }],
    ),
    end: vi.fn<(options: { timeout: number }) => Promise<void>>(async () => {}),
  };
  const resolve = vi.fn<() => Promise<string>>();
  return {
    connection,
    findApp: vi.fn<() => Promise<{ dbName: string | null } | undefined>>(),
    postgres: vi.fn<(url: string, options: unknown) => typeof connection>(
      () => connection,
    ),
    resolve,
    withAppDatabaseLifecycle: vi.fn<
      <T>(
        id: string,
        run: (database: { resolve: typeof resolve }) => Promise<T>,
      ) => Promise<T>
    >(
      async <T>(
        _id: string,
        run: (database: { resolve: typeof resolve }) => Promise<T>,
      ): Promise<T> => run({ resolve }),
    ),
  };
});

vi.mock('~/db', () => ({
  db: { query: { apps: { findFirst: mocks.findApp } } },
}));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  APP_DATABASE_NOT_PROVISIONED_ERROR:
    'App database is not provisioned. Deploy a version with capabilities.database enabled first.',
  withAppDatabaseLifecycle: mocks.withAppDatabaseLifecycle,
}));

const { queryAppDatabase } = await import('./query-db');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findApp.mockResolvedValue({ dbName: 'app_app' });
  mocks.resolve.mockResolvedValue(
    'postgres://app:stored-password@localhost/app',
  );
});

describe('queryAppDatabase', () => {
  it('queries a retained, registered database without provisioning it', async () => {
    await expect(queryAppDatabase('app', 'select 42')).resolves.toEqual({
      text: JSON.stringify([{ answer: 42 }], null, 2),
      rowCount: 1,
    });

    expect(mocks.withAppDatabaseLifecycle).toHaveBeenCalledWith(
      'app',
      expect.any(Function),
    );
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.postgres).toHaveBeenCalledWith(
      'postgres://app:stored-password@localhost/app',
      {
        max: 1,
        connection: { statement_timeout: 30000 },
      },
    );
    expect(mocks.connection.unsafe).toHaveBeenCalledWith('select 42');
    expect(mocks.connection.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('rejects an unregistered database before opening the lifecycle connection', async () => {
    mocks.findApp.mockResolvedValue({ dbName: null });

    await expect(queryAppDatabase('app', 'select 42')).rejects.toThrow(
      'App database is not provisioned',
    );

    expect(mocks.withAppDatabaseLifecycle).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it('does not recreate a registered database when resolution fails', async () => {
    mocks.resolve.mockRejectedValueOnce(
      new Error('App database is not provisioned'),
    );

    await expect(queryAppDatabase('app', 'select 42')).rejects.toThrow(
      'App database is not provisioned',
    );

    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });
});
