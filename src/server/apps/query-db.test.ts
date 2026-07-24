import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = {
    unsafe: vi.fn<(statement: string) => Promise<{ answer: number }[]>>(
      async () => [{ answer: 42 }],
    ),
    end: vi.fn<(options: { timeout: number }) => Promise<void>>(async () => {}),
  };
  return {
    connection,
    ensureAppDatabase: vi.fn<
      (id: string) => Promise<{
        url: string;
        passwordMigrated: boolean;
      }>
    >(),
    postgres: vi.fn<(url: string, options: unknown) => typeof connection>(
      () => connection,
    ),
    refreshAppBackendDatabaseCredentials: vi.fn<(id: string) => Promise<void>>(
      async () => {},
    ),
  };
});

vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  ensureAppDatabase: mocks.ensureAppDatabase,
}));
vi.mock('./runtime', () => ({
  refreshAppBackendDatabaseCredentials:
    mocks.refreshAppBackendDatabaseCredentials,
}));

const { queryAppDatabase } = await import('./query-db');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queryAppDatabase database password migration', () => {
  it('refreshes a live backend before querying with a migrated password', async () => {
    mocks.ensureAppDatabase.mockResolvedValueOnce({
      url: 'postgres://app:new-password@localhost/app',
      passwordMigrated: true,
    });

    await expect(queryAppDatabase('app', 'select 42')).resolves.toEqual({
      text: JSON.stringify([{ answer: 42 }], null, 2),
      rowCount: 1,
    });

    expect(mocks.refreshAppBackendDatabaseCredentials).toHaveBeenCalledWith(
      'app',
    );
    expect(mocks.postgres).toHaveBeenCalledWith(
      'postgres://app:new-password@localhost/app',
      {
        max: 1,
        connection: { statement_timeout: 30000 },
      },
    );
  });

  it('does not restart a backend when its stored password was reused', async () => {
    mocks.ensureAppDatabase.mockResolvedValueOnce({
      url: 'postgres://app:stored-password@localhost/app',
      passwordMigrated: false,
    });

    await queryAppDatabase('app', 'select 42');

    expect(mocks.refreshAppBackendDatabaseCredentials).not.toHaveBeenCalled();
  });
});
