import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAppDatabaseUrl: vi.fn<(id: string) => Promise<string>>(),
}));

vi.mock('./provision', () => ({
  resolveAppDatabaseUrl: mocks.resolveAppDatabaseUrl,
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
    expect(mocks.resolveAppDatabaseUrl).not.toHaveBeenCalled();
  });

  it('resolves and exposes the registered App database when enabled', async () => {
    mocks.resolveAppDatabaseUrl.mockResolvedValue(
      'postgres://app:secret@localhost/app',
    );

    await expect(appDatabaseRuntimeEnv('sql-app', true)).resolves.toEqual({
      DATABASE_URL: 'postgres://app:secret@localhost/app',
    });
    expect(mocks.resolveAppDatabaseUrl).toHaveBeenCalledWith('sql-app');
  });
});
