import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAppDatabase:
    vi.fn<
      (id: string) => Promise<{ url: string; passwordMigrated: boolean }>
    >(),
}));

vi.mock('./provision', () => ({
  ensureAppDatabase: mocks.ensureAppDatabase,
}));

import { appDatabaseRuntimeEnv } from './runtime-database';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('App backend database capability', () => {
  it('does not provision or expose a database when disabled', async () => {
    await expect(appDatabaseRuntimeEnv('data-only', false)).resolves.toEqual(
      {},
    );
    expect(mocks.ensureAppDatabase).not.toHaveBeenCalled();
  });

  it('provisions and exposes the App database when enabled', async () => {
    mocks.ensureAppDatabase.mockResolvedValue({
      url: 'postgres://app:secret@localhost/app',
      passwordMigrated: false,
    });

    await expect(appDatabaseRuntimeEnv('sql-app', true)).resolves.toEqual({
      DATABASE_URL: 'postgres://app:secret@localhost/app',
    });
    expect(mocks.ensureAppDatabase).toHaveBeenCalledWith('sql-app');
  });
});
