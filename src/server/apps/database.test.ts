import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppState = {
  status: string;
  capabilities: { database?: boolean } | null;
  dbName: string | null;
  dbPasswordCiphertext: string | null;
};

const mocks = vi.hoisted(() => ({
  app: null as AppState | null,
  events: [] as string[],
  drop: vi.fn<() => Promise<void>>(),
  updateValues: vi.fn<(values: Partial<AppState>) => void>(),
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('~/db', () => ({
  schema: { apps: { id: 'id' } },
  db: {
    query: {
      apps: {
        findFirst: async () => mocks.app,
      },
    },
    update: () => ({
      set: (values: Partial<AppState>) => ({
        where: async () => {
          mocks.updateValues(values);
          if (mocks.app) Object.assign(mocks.app, values);
        },
      }),
    }),
  },
}));
vi.mock('./deploy', () => ({
  appDeployLock: {
    withLock: async <T>(_id: string, run: () => Promise<T>): Promise<T> => {
      mocks.events.push('deploy-lock');
      return run();
    },
  },
}));
vi.mock('./data-table/provision', () => ({
  withAppDataCutoverLock: async <T>(
    _id: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    mocks.events.push('data-cutover-lock');
    return run();
  },
}));
vi.mock('./provision', () => ({
  APP_DATABASE_NOT_PROVISIONED_ERROR: 'App database is not provisioned.',
  withAppDatabaseLifecycle: async <T>(
    _id: string,
    run: (database: { drop: typeof mocks.drop }) => Promise<T>,
  ): Promise<T> => {
    mocks.events.push('database-lifecycle-lock');
    return run({ drop: mocks.drop });
  },
}));

const { deleteAppDatabase } = await import('./database');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.app = {
    status: 'deployed',
    capabilities: { database: false },
    dbName: 'app_example',
    dbPasswordCiphertext: 'encrypted-password',
  };
  mocks.drop.mockResolvedValue();
});

describe('deleteAppDatabase', () => {
  it('drops the retained resources before clearing registration and credentials', async () => {
    await expect(deleteAppDatabase('example', 'app_example')).resolves.toEqual({
      ok: true,
    });

    expect(mocks.events).toEqual([
      'deploy-lock',
      'data-cutover-lock',
      'database-lifecycle-lock',
    ]);
    expect(mocks.drop).toHaveBeenCalledOnce();
    expect(mocks.updateValues).toHaveBeenCalledWith({
      dbName: null,
      dbPasswordCiphertext: null,
    });
    expect(mocks.app).toMatchObject({
      dbName: null,
      dbPasswordCiphertext: null,
    });
  });

  it('retains the retry marker and credential when physical cleanup fails', async () => {
    const failure = new Error('role is still in use');
    mocks.drop.mockRejectedValueOnce(failure);

    await expect(deleteAppDatabase('example', 'app_example')).rejects.toBe(
      failure,
    );

    expect(mocks.updateValues).not.toHaveBeenCalled();
    expect(mocks.app).toMatchObject({
      dbName: 'app_example',
      dbPasswordCiphertext: 'encrypted-password',
    });
  });

  it.each([
    [
      'a deployment is running',
      { status: 'building' },
      'while a deployment is in progress',
    ],
    [
      'the capability is enabled',
      { capabilities: { database: true } },
      'Disable capabilities.database',
    ],
    ['the database is unregistered', { dbName: null }, 'not provisioned'],
  ])('rejects deletion when %s', async (_label, change, message) => {
    Object.assign(mocks.app as AppState, change);

    await expect(deleteAppDatabase('example', 'app_example')).rejects.toThrow(
      message,
    );

    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.updateValues).not.toHaveBeenCalled();
  });

  it('requires an exact, case-sensitive database name confirmation', async () => {
    await expect(deleteAppDatabase('example', 'APP_EXAMPLE')).rejects.toThrow(
      'confirmation does not match',
    );

    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.updateValues).not.toHaveBeenCalled();
  });
});
