import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppState = {
  status: string;
  capabilities: { dataTable?: boolean } | null;
  dataDbName: string | null;
  dataDbPasswordCiphertext: string | null;
  dataSchemaHash: string | null;
  dataActivationId: string | null;
};

const mocks = vi.hoisted(() => ({
  app: null as AppState | null,
  events: [] as string[],
  closeRealtime: vi.fn<() => Promise<void>>(),
  waitForBarrier: vi.fn<() => Promise<void>>(),
  dropDatabase: vi.fn<() => Promise<void>>(),
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
vi.mock('../deploy', () => ({
  appDeployLock: {
    withLock: async <T>(_id: string, run: () => Promise<T>): Promise<T> => {
      mocks.events.push('deploy-lock');
      return run();
    },
  },
}));
vi.mock('./provision', () => ({
  withAppDataCutoverLock: async <T>(
    _id: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    mocks.events.push('data-cutover-lock');
    return run();
  },
  dropAppDataDatabase: mocks.dropDatabase,
}));
vi.mock('./migrate', () => ({
  waitForDataMigrationBarrier: mocks.waitForBarrier,
}));
vi.mock('./realtime', () => ({ closeDataRealtime: mocks.closeRealtime }));

const { deleteAppDataDatabase } = await import('./delete');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.app = {
    status: 'deployed',
    capabilities: { dataTable: false },
    dataDbName: 'hatch_data_example',
    dataDbPasswordCiphertext: 'encrypted-password',
    dataSchemaHash: 'schema-hash',
    dataActivationId: null,
  };
  mocks.closeRealtime.mockImplementation(async () => {
    mocks.events.push('close-realtime');
  });
  mocks.waitForBarrier.mockImplementation(async () => {
    mocks.events.push('migration-barrier');
  });
  mocks.dropDatabase.mockImplementation(async () => {
    mocks.events.push('drop-data-database');
  });
});

describe('deleteAppDataDatabase', () => {
  it('drains readers and drops resources before clearing retained state', async () => {
    await expect(
      deleteAppDataDatabase('example', 'hatch_data_example'),
    ).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual([
      'deploy-lock',
      'data-cutover-lock',
      'close-realtime',
      'migration-barrier',
      'drop-data-database',
    ]);
    expect(mocks.updateValues).toHaveBeenCalledWith({
      dataDbName: null,
      dataDbPasswordCiphertext: null,
      dataSchemaHash: null,
      dataActivationId: null,
    });
    expect(mocks.app).toMatchObject({
      dataDbName: null,
      dataDbPasswordCiphertext: null,
      dataSchemaHash: null,
      dataActivationId: null,
    });
  });

  it('retains every retry marker when physical cleanup fails', async () => {
    const failure = new Error('role is still in use');
    mocks.dropDatabase.mockRejectedValueOnce(failure);

    await expect(
      deleteAppDataDatabase('example', 'hatch_data_example'),
    ).rejects.toBe(failure);

    expect(mocks.updateValues).not.toHaveBeenCalled();
    expect(mocks.app).toMatchObject({
      dataDbName: 'hatch_data_example',
      dataDbPasswordCiphertext: 'encrypted-password',
      dataSchemaHash: 'schema-hash',
    });
  });

  it('drops a reserved database without opening it when no credential exists', async () => {
    if (!mocks.app) throw new Error('Missing App fixture.');
    mocks.app.dataDbPasswordCiphertext = null;

    await expect(
      deleteAppDataDatabase('example', 'hatch_data_example'),
    ).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual([
      'deploy-lock',
      'data-cutover-lock',
      'close-realtime',
      'drop-data-database',
    ]);
    expect(mocks.waitForBarrier).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a deployment is running',
      { status: 'building' },
      'while a deployment is in progress',
    ],
    [
      'the capability is enabled',
      { capabilities: { dataTable: true } },
      'Disable capabilities.dataTable',
    ],
    [
      'an activation is pending',
      { dataActivationId: 'pending-deployment' },
      'deployment is being finalized',
    ],
    ['the database is unregistered', { dataDbName: null }, 'not provisioned'],
  ])('rejects deletion when %s', async (_label, change, message) => {
    Object.assign(mocks.app as AppState, change);

    await expect(
      deleteAppDataDatabase('example', 'hatch_data_example'),
    ).rejects.toThrow(message);

    expect(mocks.closeRealtime).not.toHaveBeenCalled();
    expect(mocks.waitForBarrier).not.toHaveBeenCalled();
    expect(mocks.dropDatabase).not.toHaveBeenCalled();
    expect(mocks.updateValues).not.toHaveBeenCalled();
  });

  it('requires an exact, case-sensitive database name confirmation', async () => {
    await expect(
      deleteAppDataDatabase('example', 'HATCH_DATA_EXAMPLE'),
    ).rejects.toThrow('confirmation does not match');

    expect(mocks.closeRealtime).not.toHaveBeenCalled();
    expect(mocks.dropDatabase).not.toHaveBeenCalled();
  });
});
