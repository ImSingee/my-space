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
    ensureAppDatabase: vi.fn<(id: string) => Promise<string>>(),
    postgres: vi.fn<(url: string, options: unknown) => typeof connection>(
      () => connection,
    ),
  };
});

vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  ensureAppDatabase: mocks.ensureAppDatabase,
}));

const { queryAppDatabase } = await import('./query-db');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureAppDatabase.mockResolvedValue(
    'postgres://app:stored-password@localhost/app',
  );
});

describe('queryAppDatabase', () => {
  it('queries using the app database URL returned by provisioning', async () => {
    await expect(queryAppDatabase('app', 'select 42')).resolves.toEqual({
      text: JSON.stringify([{ answer: 42 }], null, 2),
      rowCount: 1,
    });

    expect(mocks.ensureAppDatabase).toHaveBeenCalledWith('app');
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
});
