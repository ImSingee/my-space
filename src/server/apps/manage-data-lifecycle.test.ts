import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  findApp: vi.fn<() => Promise<unknown>>(),
  findDeployment: vi.fn<() => Promise<unknown>>(),
  findDeployments: vi.fn<() => Promise<unknown[]>>(),
  update: vi.fn<() => unknown>(),
  updateSet: vi.fn<(values: Record<string, unknown>) => unknown>(),
  updateWhere: vi.fn<() => Promise<unknown[]>>(),
  deleteRow: vi.fn<() => unknown>(),
  deleteWhere: vi.fn<() => unknown>(),
  deleteReturning: vi.fn<() => Promise<unknown[]>>(),
  transaction:
    vi.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
  acquireDeployLock: vi.fn<() => Promise<void>>(),
  currentDataSchema: vi.fn<() => Promise<unknown>>(),
  recoverCurrentDataSchema: vi.fn<() => Promise<unknown>>(),
  buildMatchesDeployment:
    vi.fn<
      (id: string, deploymentId: string, buildDir: string) => Promise<boolean>
    >(),
  waitForDataMigrationBarrier: vi.fn<() => Promise<void>>(),
  closeDataRealtime: vi.fn<() => Promise<void>>(),
  dropAppDataDatabase: vi.fn<() => Promise<void>>(),
  dropAppDatabase: vi.fn<() => Promise<void>>(),
  stopApp: vi.fn<(id: string) => void>(),
  reloadScheduler: vi.fn<() => Promise<void>>(),
  moveMasterToDeploymentTag: vi.fn<() => Promise<string>>(),
  broadcastCleanup:
    vi.fn<
      (scope: 'app' | 'workflow', id: string, generation: string) => void
    >(),
  fsAccess: vi.fn<() => Promise<void>>(),
  fsRm: vi.fn<
    (
      target: string,
      options?: { recursive?: boolean; force?: boolean },
    ) => Promise<void>
  >(),
  fsMkdir: vi.fn<() => Promise<void>>(),
  fsCp: vi.fn<() => Promise<void>>(),
  fsWriteFile: vi.fn<() => Promise<void>>(),
  fsReaddir: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock('node:fs', () => ({
  promises: {
    access: mocks.fsAccess,
    rm: mocks.fsRm,
    mkdir: mocks.fsMkdir,
    cp: mocks.fsCp,
    writeFile: mocks.fsWriteFile,
    readdir: mocks.fsReaddir,
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn<(left: unknown, right: unknown) => Record<string, never>>(
    () => ({}),
  ),
  sql: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => string>(
    (strings) => strings.join(''),
  ),
}));
vi.mock('~agent/paths', () => ({
  AGENTS_DIR: '/workspace/agents',
  agentAppWorkDir: (session: string, id: string) =>
    `/workspace/agents/${session}/apps/${id}`,
  agentWorkDir: (session: string) => `/workspace/agents/${session}`,
  appArtifactsDir: (id: string) => `/workspace/artifacts/${id}`,
  appBuildDir: (id: string) => `/workspace/build/${id}`,
  appRepoDir: (id: string) => `/workspace/repos/${id}`,
  appSrcDir: (id: string) => `/workspace/src/${id}`,
  appStorageDir: (id: string) => `/workspace/storage/${id}`,
  appVersionsDir: (id: string) => `/workspace/versions/${id}`,
  deploymentArtifactDir: (id: string, deploymentId: string) =>
    `/workspace/artifacts/${id}/${deploymentId}`,
  deploymentBuildDir: (id: string, deploymentId: string) =>
    `/workspace/versions/${id}/${deploymentId}`,
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: {
        findFirst: mocks.findDeployment,
        findMany: mocks.findDeployments,
      },
    },
    update: mocks.update,
    delete: mocks.deleteRow,
    transaction: mocks.transaction,
  },
  schema: {
    apps: {
      id: 'apps.id',
      status: 'apps.status',
      userscriptRevision: 'apps.userscript_revision',
      createdAt: 'apps.created_at',
    },
  },
}));
vi.mock('./deploy', () => ({
  appDeployLock: {
    withLock: async (_id: string, run: () => Promise<unknown>) => {
      mocks.events.push('app-lock');
      return run();
    },
    acquire: mocks.acquireDeployLock,
  },
}));
vi.mock('./build-identity', () => ({
  buildMatchesDeployment: mocks.buildMatchesDeployment,
}));
vi.mock('./git', () => ({
  moveMasterToDeploymentTag: mocks.moveMasterToDeploymentTag,
  worktreeOrigin: vi.fn<(worktree: string) => Promise<string | null>>(
    async () => null,
  ),
}));
vi.mock('./manifest', () => ({
  isValidAppId: () => true,
  isValidAppSlug: () => true,
}));
vi.mock('./provision', () => ({ dropAppDatabase: mocks.dropAppDatabase }));
vi.mock('./data-table/provision', () => ({
  dropAppDataDatabase: mocks.dropAppDataDatabase,
  withAppDataCutoverLock: async (_id: string, run: () => Promise<unknown>) => {
    mocks.events.push('cutover-lock');
    return run();
  },
}));
vi.mock('./data-table/migrate', () => ({
  currentDataSchema: mocks.currentDataSchema,
  recoverCurrentDataSchema: mocks.recoverCurrentDataSchema,
  waitForDataMigrationBarrier: mocks.waitForDataMigrationBarrier,
}));
vi.mock('./data-table/realtime', () => ({
  closeDataRealtime: mocks.closeDataRealtime,
}));
vi.mock('./runtime', () => ({
  ensureAppRunning: vi.fn<
    (id: string, expectedDeploymentId?: string) => Promise<number>
  >(async () => 1234),
  setKeepAlive: vi.fn<(id: string, on: boolean) => void>(),
  stopApp: mocks.stopApp,
}));
vi.mock('./scheduler', () => ({ reloadScheduler: mocks.reloadScheduler }));
vi.mock('../agent-runner/hub', () => ({
  broadcastEntityWorkspaceCleanup: mocks.broadcastCleanup,
}));

import {
  deleteApp,
  listDeployments,
  rollbackApp,
  setAppArchived,
} from './manage';

const APP_ID = 'example';
const CURRENT_DEPLOYMENT_ID = 'deployment-v2';
const TARGET_DEPLOYMENT_ID = 'deployment-v1';

describe('App Data lifecycle recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.updates.length = 0;
    mocks.update.mockImplementation(() => ({ set: mocks.updateSet }));
    mocks.updateSet.mockImplementation((values) => {
      mocks.updates.push(values);
      return { where: mocks.updateWhere };
    });
    mocks.updateWhere.mockResolvedValue([]);
    mocks.findDeployments.mockResolvedValue([]);
    mocks.currentDataSchema.mockResolvedValue(null);
    mocks.deleteRow.mockImplementation(() => ({ where: mocks.deleteWhere }));
    mocks.deleteWhere.mockImplementation(() => ({
      returning: mocks.deleteReturning,
    }));
    mocks.deleteReturning.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback) =>
      callback({ update: mocks.update }),
    );
    mocks.acquireDeployLock.mockResolvedValue();
    mocks.waitForDataMigrationBarrier.mockImplementation(async () => {
      mocks.events.push('migration-barrier');
    });
    mocks.closeDataRealtime.mockImplementation(async () => {
      mocks.events.push('close-realtime');
    });
    mocks.dropAppDataDatabase.mockImplementation(async () => {
      mocks.events.push('drop-data-db');
    });
    mocks.dropAppDatabase.mockResolvedValue();
    mocks.reloadScheduler.mockResolvedValue();
    mocks.moveMasterToDeploymentTag.mockResolvedValue('source-commit-v1');
    mocks.buildMatchesDeployment.mockResolvedValue(true);
    mocks.fsAccess.mockResolvedValue();
    mocks.fsRm.mockResolvedValue();
    mocks.fsMkdir.mockResolvedValue();
    mocks.fsCp.mockResolvedValue();
    mocks.fsWriteFile.mockResolvedValue();
    mocks.fsReaddir.mockResolvedValue([]);
  });

  it('requires rollback confirmation while Data activation is pending', async () => {
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      dataDbName: 'data-example',
      dataSchemaHash: 'last-known-hash',
      dataActivationId: 'pending-deployment',
    });
    mocks.findDeployments.mockResolvedValue([
      {
        id: CURRENT_DEPLOYMENT_ID,
        version: 2,
        status: 'deployed',
        message: 'Current',
        error: null,
        createdAt: new Date('2026-07-24T00:00:00Z'),
        sourceCommit: 'source-v2',
        sourceTag: 'deploy/v2',
        artifactPath: '/workspace/artifacts/example/deployment-v2',
        buildLog: null,
        dataSchemaHash: 'pending-hash',
      },
      {
        id: TARGET_DEPLOYMENT_ID,
        version: 1,
        status: 'deployed',
        message: 'Previous',
        error: null,
        createdAt: new Date('2026-07-23T00:00:00Z'),
        sourceCommit: 'source-v1',
        sourceTag: 'deploy/v1',
        artifactPath: '/workspace/artifacts/example/deployment-v1',
        buildLog: null,
        // A racing plain SELECT would also return this stale hash and suppress
        // confirmation without the conservative activation-pending rule.
        dataSchemaHash: 'last-known-hash',
      },
    ]);

    const deployments = await listDeployments(APP_ID);

    expect(
      deployments.find((row) => row.id === TARGET_DEPLOYMENT_ID),
    ).toMatchObject({ canRollback: true, dataSchemaMismatch: true });
    expect(mocks.currentDataSchema).not.toHaveBeenCalled();
  });

  it('retains an unresolved activation fence when rollback recovery fails', async () => {
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      name: 'Example',
      status: 'deployed',
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      currentSourceCommit: 'source-commit-v2',
      capabilities: { dataTable: true, backend: false },
      backendMode: 'serverless',
      manifest: {},
      dataDbName: 'data-example',
      dataSchemaHash: 'last-known-hash',
      dataActivationId: 'pending-deployment',
    });
    mocks.findDeployment.mockResolvedValue({
      id: TARGET_DEPLOYMENT_ID,
      appId: APP_ID,
      version: 1,
      status: 'deployed',
      sourceTag: 'deploy/v1',
      manifestNormalized: {
        name: 'Example',
        description: '',
        capabilities: { dataTable: true, backend: false },
        backendMode: 'serverless',
      },
      dataSchemaHash: 'last-known-hash',
    });
    mocks.recoverCurrentDataSchema.mockRejectedValue(
      new Error('Data database is unavailable'),
    );

    await expect(rollbackApp(APP_ID, TARGET_DEPLOYMENT_ID)).resolves.toEqual({
      version: 1,
      dataSchemaMismatch: true,
    });

    const activationUpdate = mocks.updates.find(
      (update) => update.currentDeploymentId === TARGET_DEPLOYMENT_ID,
    );
    expect(activationUpdate).toMatchObject({
      dataSchemaHash: 'last-known-hash',
      dataActivationId: 'pending-deployment',
    });
    expect(mocks.fsRm).not.toHaveBeenCalledWith(
      `/workspace/build/${APP_ID}.bak-pending-deployment`,
      expect.anything(),
    );
  });

  it('removes a pending backup before clearing a resolved activation fence', async () => {
    const targetManifest = {
      name: 'Example',
      description: 'Previous deployment',
      capabilities: { dataTable: true, backend: false, cron: true },
      backendMode: 'serverless',
    };
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      name: 'Example',
      status: 'deployed',
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      currentSourceCommit: 'source-commit-v2',
      capabilities: { dataTable: true, backend: true, cron: false },
      backendMode: 'long-running',
      manifest: { name: 'Current deployment' },
      dataDbName: 'data-example',
      dataSchemaHash: 'last-known-hash',
      dataActivationId: 'pending-deployment',
    });
    mocks.findDeployment.mockResolvedValue({
      id: TARGET_DEPLOYMENT_ID,
      appId: APP_ID,
      version: 1,
      status: 'deployed',
      sourceTag: 'deploy/v1',
      manifestNormalized: targetManifest,
      dataSchemaHash: 'committed-hash',
    });
    mocks.recoverCurrentDataSchema.mockResolvedValue({
      hash: 'committed-hash',
    });

    await expect(rollbackApp(APP_ID, TARGET_DEPLOYMENT_ID)).resolves.toEqual({
      version: 1,
      dataSchemaMismatch: false,
    });

    const backup = `/workspace/build/${APP_ID}.bak-pending-deployment`;
    const backupCallIndex = mocks.fsRm.mock.calls.findIndex(
      ([target]) => target === backup,
    );
    expect(backupCallIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.fsRm).toHaveBeenCalledWith(backup, {
      recursive: true,
      force: true,
    });
    expect(
      mocks.fsRm.mock.invocationCallOrder[backupCallIndex] as number,
    ).toBeLessThan(mocks.updateSet.mock.invocationCallOrder.at(-1) as number);
    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        currentDeploymentId: TARGET_DEPLOYMENT_ID,
        description: 'Previous deployment',
        capabilities: targetManifest.capabilities,
        backendMode: targetManifest.backendMode,
        manifest: targetManifest,
        dataSchemaHash: 'committed-hash',
        dataActivationId: null,
      }),
    );
  });

  it('does not clear a resolved fence when pending backup cleanup fails', async () => {
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      name: 'Example',
      status: 'deployed',
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      currentSourceCommit: 'source-commit-v2',
      capabilities: { dataTable: true, backend: false },
      backendMode: 'serverless',
      manifest: {},
      dataDbName: 'data-example',
      dataSchemaHash: 'last-known-hash',
      dataActivationId: 'pending-deployment',
    });
    mocks.findDeployment.mockResolvedValue({
      id: TARGET_DEPLOYMENT_ID,
      appId: APP_ID,
      version: 1,
      status: 'deployed',
      sourceTag: 'deploy/v1',
      manifestNormalized: {
        name: 'Example',
        description: '',
        capabilities: { dataTable: true, backend: false },
        backendMode: 'serverless',
      },
      dataSchemaHash: 'committed-hash',
    });
    mocks.recoverCurrentDataSchema.mockResolvedValue({
      hash: 'committed-hash',
    });
    const cleanupFailure = new Error('backup cleanup failed');
    mocks.fsRm.mockResolvedValueOnce().mockRejectedValueOnce(cleanupFailure);

    await expect(rollbackApp(APP_ID, TARGET_DEPLOYMENT_ID)).rejects.toBe(
      cleanupFailure,
    );

    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ dataActivationId: null }),
    );
  });

  it('rejects a rollback artifact whose deployment identity is invalid', async () => {
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      name: 'Example',
      status: 'deployed',
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      capabilities: { dataTable: false, backend: false },
      backendMode: 'serverless',
      manifest: {},
      dataSchemaHash: null,
      dataActivationId: null,
    });
    mocks.findDeployment.mockResolvedValue({
      id: TARGET_DEPLOYMENT_ID,
      appId: APP_ID,
      version: 1,
      status: 'deployed',
      sourceTag: 'deploy/v1',
      manifestNormalized: {
        name: 'Example',
        capabilities: { dataTable: false, backend: false },
        backendMode: 'serverless',
      },
      dataSchemaHash: null,
    });
    mocks.buildMatchesDeployment.mockResolvedValue(false);

    await expect(rollbackApp(APP_ID, TARGET_DEPLOYMENT_ID)).rejects.toThrow(
      'does not match its deployment',
    );

    expect(mocks.buildMatchesDeployment).toHaveBeenCalledWith(
      APP_ID,
      TARGET_DEPLOYMENT_ID,
      `/workspace/artifacts/${APP_ID}/${TARGET_DEPLOYMENT_ID}`,
    );
    expect(mocks.fsRm).not.toHaveBeenCalled();
    expect(mocks.moveMasterToDeploymentTag).not.toHaveBeenCalled();
  });

  it('serializes archive behind deploy and Data cutover locks', async () => {
    mocks.findApp.mockResolvedValue({
      id: APP_ID,
      status: 'deployed',
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      capabilities: { dataTable: true },
      dataDbName: 'data-example',
    });

    await expect(setAppArchived(APP_ID, true)).resolves.toEqual({
      status: 'archived',
    });

    expect(mocks.events).toEqual([
      'app-lock',
      'cutover-lock',
      'close-realtime',
      'migration-barrier',
    ]);
    expect(mocks.updates).toContainEqual({ status: 'archived' });
    expect(mocks.stopApp).toHaveBeenCalledWith(APP_ID);
  });

  it('serializes deletion and preserves the row when Data DB drop fails', async () => {
    mocks.findApp.mockResolvedValue({
      capabilities: { dataTable: false },
      dataDbName: 'data-example',
      dataSchemaHash: null,
      dataActivationId: null,
    });
    const failure = new Error('drop failed');
    mocks.dropAppDataDatabase.mockImplementation(async () => {
      mocks.events.push('drop-data-db');
      throw failure;
    });

    await expect(deleteApp(APP_ID)).rejects.toBe(failure);

    expect(mocks.events).toEqual([
      'app-lock',
      'cutover-lock',
      'close-realtime',
      'migration-barrier',
      'drop-data-db',
    ]);
    expect(mocks.deleteRow).not.toHaveBeenCalled();
    expect(mocks.updates).toContainEqual({ status: 'archived' });
  });

  it('drops a reserved Data DB before deleting its App row', async () => {
    mocks.findApp.mockResolvedValue({
      capabilities: { dataTable: false },
      dataDbName: 'data-example',
      dataSchemaHash: null,
      dataActivationId: null,
    });

    await expect(deleteApp(APP_ID)).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual([
      'app-lock',
      'cutover-lock',
      'close-realtime',
      'migration-barrier',
      'drop-data-db',
    ]);
    expect(mocks.dropAppDataDatabase).toHaveBeenCalledOnce();
    expect(mocks.deleteRow).toHaveBeenCalledOnce();
  });

  it('deletes an App without connecting to an unused managed Data DB', async () => {
    mocks.findApp.mockResolvedValue({
      capabilities: { dataTable: false },
      dataDbName: null,
      dataSchemaHash: null,
      dataActivationId: null,
    });

    await expect(deleteApp(APP_ID)).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual(['app-lock', 'cutover-lock']);
    expect(mocks.closeDataRealtime).not.toHaveBeenCalled();
    expect(mocks.waitForDataMigrationBarrier).not.toHaveBeenCalled();
    expect(mocks.dropAppDataDatabase).not.toHaveBeenCalled();
    expect(mocks.deleteRow).toHaveBeenCalled();
    expect(mocks.fsRm).toHaveBeenCalledWith(`/workspace/storage/${APP_ID}`, {
      recursive: true,
      force: true,
    });
  });
});
