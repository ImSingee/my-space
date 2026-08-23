import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Predicate =
  | { op: 'eq'; field: string; value: unknown }
  | { op: 'and'; predicates: Predicate[] };
type QueryFilter = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  root: `/tmp/hatch-deploy-recovery-${process.pid}`,
  apps: new Map<string, Row>(),
  deployments: new Map<string, Row>(),
  deploymentReadFailures: new Set<string>(),
  appUpdateFailure: undefined as Error | undefined,
  releaseCommitAckFailure: undefined as Error | undefined,
  events: [] as string[],
  heldAppLocks: new Set<string>(),
  heldCutoverLocks: new Set<string>(),
  appStack: [] as string[],
  updates: [] as Array<{ values: Row; predicate: Predicate }>,
  buildApp: vi.fn<(id: string, options: unknown) => Promise<unknown>>(),
  liveBuildMatchesDeployment:
    vi.fn<(id: string, deploymentId: string) => Promise<boolean>>(),
  buildMatchesDeployment:
    vi.fn<
      (id: string, deploymentId: string, buildDir: string) => Promise<boolean>
    >(),
  applyDataMigration: vi.fn<(options: unknown) => Promise<unknown>>(),
  recoverCurrentDataSchema: vi.fn<(id: string) => Promise<unknown>>(),
  stopApp: vi.fn<(id: string) => void>(),
  ensureAppRunning:
    vi.fn<(id: string, deploymentId: string) => Promise<number>>(),
  setKeepAlive: vi.fn<(id: string, keepAlive: boolean) => void>(),
  reloadScheduler: vi.fn<() => Promise<void>>(),
  publishPlatformEvent: vi.fn<(event: unknown) => void>(),
  assertDeployableWorktree:
    vi.fn<(id: string, sourceDir: string) => Promise<void>>(),
  deleteDeploymentTag: vi.fn<(id: string, tag: string) => Promise<void>>(),
  prepareDeployCheckout: vi.fn<(id: string) => Promise<string>>(),
  publishDeploymentSource:
    vi.fn<
      (id: string, sourceDir: string, version: number) => Promise<unknown>
    >(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (field: string, value: unknown): Predicate => ({
    op: 'eq',
    field,
    value,
  }),
  and: (...predicates: Predicate[]): Predicate => ({
    op: 'and',
    predicates,
  }),
  sql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('~agent/paths', () => ({
  BUILD_WORK_DIR: `${mocks.root}/work`,
  appBuildDir: (id: string) => `${mocks.root}/live/${id}`,
  deploymentArtifactDir: (id: string, deploymentId: string) =>
    `${mocks.root}/artifacts/${id}/${deploymentId}`,
  deploymentBuildDir: (id: string, deploymentId: string) =>
    `${mocks.root}/versions/${id}/${deploymentId}`,
}));

vi.mock('~server/deploy-lock', () => ({
  createDeployLock: () => ({
    ns: 1,
    withLock: async <T>(id: string, run: () => Promise<T>): Promise<T> => {
      mocks.events.push(`app:start:${id}`);
      mocks.heldAppLocks.add(id);
      mocks.appStack.push(id);
      try {
        return await run();
      } finally {
        mocks.appStack.pop();
        mocks.heldAppLocks.delete(id);
        mocks.events.push(`app:end:${id}`);
      }
    },
    acquire: async (_tx: unknown, id: string): Promise<void> => {
      mocks.events.push(`db:${id}`);
      if (!mocks.heldAppLocks.has(id)) {
        throw new Error(
          `Database lock for ${id} was acquired outside app lock`,
        );
      }
    },
  }),
  workspaceRelative: (value: string) => value,
}));

vi.mock('~/db', () => {
  const schema = {
    apps: {
      id: 'id',
      status: 'status',
      currentDeploymentId: 'currentDeploymentId',
      dataActivationId: 'dataActivationId',
    },
    deployments: {
      id: 'id',
      appId: 'appId',
      version: 'version',
      sourceTag: 'sourceTag',
    },
  };

  const equal = (field: string, value: unknown): Predicate => ({
    op: 'eq',
    field,
    value,
  });
  const all = (...predicates: Predicate[]): Predicate => ({
    op: 'and',
    predicates,
  });
  const matches = (row: Row, predicate: Predicate): boolean =>
    predicate.op === 'eq'
      ? row[predicate.field] === predicate.value
      : predicate.predicates.every((child) => matches(row, child));
  const matchesField = (value: unknown, filter: unknown): boolean => {
    if (
      filter === null ||
      typeof filter !== 'object' ||
      Array.isArray(filter)
    ) {
      return value === filter;
    }
    return Object.entries(filter).every(([operator, operand]) => {
      switch (operator) {
        case 'eq':
          return value === operand;
        case 'ne':
          return value !== operand;
        case 'gt':
          return (value as number | string) > (operand as number | string);
        case 'gte':
          return (value as number | string) >= (operand as number | string);
        case 'lt':
          return (value as number | string) < (operand as number | string);
        case 'lte':
          return (value as number | string) <= (operand as number | string);
        case 'in':
          return (operand as unknown[]).includes(value);
        case 'notIn':
          return !(operand as unknown[]).includes(value);
        case 'isNull':
          return operand === true ? value === null : true;
        case 'isNotNull':
          return operand === true ? value !== null : true;
        case 'AND':
          return (operand as unknown[]).every((child) =>
            matchesField(value, child),
          );
        case 'OR':
          return (operand as unknown[]).some((child) =>
            matchesField(value, child),
          );
        case 'NOT':
          return !matchesField(value, operand);
        default:
          return false;
      }
    });
  };
  const matchesFilter = (row: Row, filter: QueryFilter): boolean =>
    Object.entries(filter).every(([field, value]) => {
      switch (field) {
        case 'AND':
          return (value as QueryFilter[]).every((child) =>
            matchesFilter(row, child),
          );
        case 'OR':
          return (value as QueryFilter[]).some((child) =>
            matchesFilter(row, child),
          );
        case 'NOT':
          return !matchesFilter(row, value as QueryFilter);
        default:
          return matchesField(row[field], value);
      }
    });
  const filterFrom = (
    where: unknown,
    table: Record<string, string>,
  ): Predicate | QueryFilter | undefined =>
    typeof where === 'function'
      ? (where(table, { and: all, eq: equal, isNotNull: () => undefined }) as
          | Predicate
          | undefined)
      : (where as Predicate | QueryFilter | undefined);
  const isPredicate = (filter: Predicate | QueryFilter): filter is Predicate =>
    filter.op === 'eq' || filter.op === 'and';
  const matchesWhere = (row: Row, filter: Predicate | QueryFilter): boolean =>
    isPredicate(filter) ? matches(row, filter) : matchesFilter(row, filter);
  const select = (
    rows: Iterable<Row>,
    options: { where?: unknown } | undefined,
    table: Record<string, string>,
  ): Row | undefined => {
    const filter = filterFrom(options?.where, table);
    return [...rows].find((row) => !filter || matchesWhere(row, filter));
  };

  const appFindFirst = async (options?: { where?: unknown }) =>
    select(mocks.apps.values(), options, schema.apps);
  const deploymentFindFirst = async (options?: { where?: unknown }) => {
    const activeApp = mocks.appStack.at(-1);
    if (activeApp && mocks.deploymentReadFailures.has(activeApp)) {
      throw new Error(`Deployment outcome for ${activeApp} is unavailable`);
    }
    return select(mocks.deployments.values(), options, schema.deployments);
  };
  const query = {
    apps: {
      findFirst: appFindFirst,
      findMany: async (options?: { where?: unknown }) =>
        [...mocks.apps.values()]
          .filter((app) => {
            const filter = filterFrom(options?.where, schema.apps);
            return !filter || matchesWhere(app, filter);
          })
          .map((app) => ({ id: app.id })),
    },
    deployments: { findFirst: deploymentFindFirst },
  };
  const update = () => ({
    set: (values: Row) => ({
      where: (predicate: Predicate) => {
        const matched = [...mocks.apps.values()].filter((app) =>
          matches(app, predicate),
        );
        mocks.updates.push({ values, predicate });
        const failure = mocks.appUpdateFailure;
        if (!failure) {
          for (const app of matched) Object.assign(app, values);
        }
        const result = Promise.resolve(undefined);
        return Object.assign(result, {
          returning: async () => {
            if (failure) throw failure;
            return matched.map((app) => ({ id: app.id }));
          },
        });
      },
    }),
  });
  return {
    db: {
      query,
      transaction: async <T>(
        run: (transaction: {
          query: typeof query;
          update: typeof update;
          insert: () => { values: (row: Row) => Promise<void> };
        }) => Promise<T>,
      ) => {
        let inserted = false;
        const result = await run({
          query,
          update,
          insert: () => ({
            values: async (row: Row) => {
              inserted = true;
              mocks.deployments.set(row.id as string, row);
            },
          }),
        });
        if (inserted && mocks.releaseCommitAckFailure) {
          const failure = mocks.releaseCommitAckFailure;
          mocks.releaseCommitAckFailure = undefined;
          throw failure;
        }
        return result;
      },
      update,
    },
    schema,
  };
});

vi.mock('./build', () => ({ buildApp: mocks.buildApp }));
vi.mock('./build-identity', () => ({
  buildMatchesDeployment: mocks.buildMatchesDeployment,
  liveBuildMatchesDeployment: mocks.liveBuildMatchesDeployment,
}));
vi.mock('./git', () => ({
  assertDeployableWorktree: mocks.assertDeployableWorktree,
  deleteDeploymentTag: mocks.deleteDeploymentTag,
  prepareDeployCheckout: mocks.prepareDeployCheckout,
  publishDeploymentSource: mocks.publishDeploymentSource,
}));
vi.mock('./provision', () => ({
  appDbName: (id: string) => `app_${id}`,
  ensureAppDatabase: vi.fn<(id: string) => Promise<string>>(),
}));
vi.mock('./runtime', () => ({
  ensureAppRunning: mocks.ensureAppRunning,
  setKeepAlive: mocks.setKeepAlive,
  stopApp: mocks.stopApp,
}));
vi.mock('./scheduler', () => ({ reloadScheduler: mocks.reloadScheduler }));
vi.mock('~server/platform-events', () => ({
  publishPlatformEvent: mocks.publishPlatformEvent,
}));
vi.mock('./data-table/migrate', () => ({
  applyDataMigration: mocks.applyDataMigration,
  DataMigrationOutcomeUnknown: class DataMigrationOutcomeUnknown extends Error {},
  recoverCurrentDataSchema: mocks.recoverCurrentDataSchema,
}));
vi.mock('./data-table/provision', () => ({
  appDataDbName: (id: string) => `data_${id}`,
  withAppDataCutoverLock: async <T>(
    id: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    mocks.events.push(`cutover:start:${id}`);
    if (!mocks.heldAppLocks.has(id)) {
      throw new Error(`Cutover lock for ${id} was acquired outside app lock`);
    }
    mocks.heldCutoverLocks.add(id);
    try {
      return await run();
    } finally {
      mocks.heldCutoverLocks.delete(id);
      mocks.events.push(`cutover:end:${id}`);
    }
  },
}));

import { deployApp, reconcilePendingAppActivations } from './deploy';

function appState(id: string, options: Partial<Row> = {}): Row {
  return {
    id,
    status: 'building',
    currentDeploymentId: 'deployment-current',
    capabilities: { backend: false, dataTable: false },
    backendMode: 'serverless',
    dataSchemaHash: null,
    dataActivationId: 'deployment-pending',
    ...options,
  };
}

function deploymentState(
  id: string,
  appId: string,
  options: Partial<Row> = {},
): Row {
  return { id, appId, dataSchemaHash: null, ...options };
}

async function writeBuild(
  root: string,
  deploymentId: string,
  body: string,
): Promise<void> {
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'deployment.json'),
    JSON.stringify({ deploymentId }),
    'utf8',
  );
  await fs.writeFile(path.join(root, 'app', 'index.html'), body, 'utf8');
}

async function stageDataTableBuild(
  _id: string,
  rawOptions: unknown,
): Promise<unknown> {
  const { deploymentId, outputDir } = rawOptions as {
    deploymentId: string;
    outputDir: string;
  };
  await writeBuild(outputDir, deploymentId, 'retry build');
  return {
    source: {
      name: 'Recovery retry',
      description: '',
      capabilities: {
        database: false,
        frontend: true,
        widgets: false,
        backend: false,
        cron: false,
        webhook: false,
        kv: false,
        dataTable: true,
      },
      backendMode: 'serverless',
      workflows: [],
    },
    normalized: { workflows: [], cron: [] },
    dataSchema: { version: 1, tables: {} },
    log: '',
  };
}

async function stageFrontendBuild(
  _id: string,
  rawOptions: unknown,
): Promise<unknown> {
  const { deploymentId, outputDir } = rawOptions as {
    deploymentId: string;
    outputDir: string;
  };
  await writeBuild(outputDir, deploymentId, 'deployed frontend');
  return {
    source: {
      name: 'Deployed app',
      description: '',
      capabilities: {
        database: false,
        frontend: true,
        widgets: false,
        backend: false,
        cron: false,
        webhook: false,
        kv: false,
        dataTable: false,
      },
      backendMode: 'serverless',
      workflows: [],
    },
    normalized: { workflows: [], cron: [] },
    dataSchema: null,
    log: 'build complete',
  };
}

async function arrangeSupersededPendingArtifact(id: string): Promise<{
  app: Row;
  pendingArtifact: string;
  pendingId: string;
}> {
  const currentId = 'deployment-current';
  const pendingId = 'deployment-superseded';
  const app = appState(id, {
    status: 'deployed',
    currentDeploymentId: currentId,
    capabilities: { backend: false, dataTable: true },
    dataSchemaHash: 'current-code-hash',
    dataActivationId: pendingId,
  });
  mocks.apps.set(id, app);
  mocks.deployments.set(
    currentId,
    deploymentState(currentId, id, { dataSchemaHash: 'current-code-hash' }),
  );
  await writeBuild(
    `${mocks.root}/live/${id}.bak-${pendingId}`,
    currentId,
    'current deployment',
  );
  const pendingArtifact = `${mocks.root}/artifacts/${id}/${pendingId}`;
  await writeBuild(pendingArtifact, pendingId, 'superseded deployment');
  mocks.recoverCurrentDataSchema.mockResolvedValue({
    schema: { version: 1, tables: {} },
    hash: 'migrated-hash',
  });
  mocks.buildApp.mockImplementationOnce(stageDataTableBuild);
  return { app, pendingArtifact, pendingId };
}

describe('App deployment activation recovery', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.apps.clear();
    mocks.deployments.clear();
    mocks.deploymentReadFailures.clear();
    mocks.appUpdateFailure = undefined;
    mocks.releaseCommitAckFailure = undefined;
    mocks.events.length = 0;
    mocks.heldAppLocks.clear();
    mocks.heldCutoverLocks.clear();
    mocks.appStack.length = 0;
    mocks.updates.length = 0;
    mocks.liveBuildMatchesDeployment.mockResolvedValue(true);
    mocks.buildMatchesDeployment.mockResolvedValue(true);
    mocks.recoverCurrentDataSchema.mockResolvedValue(null);
    mocks.ensureAppRunning.mockResolvedValue(1234);
    mocks.reloadScheduler.mockResolvedValue();
    mocks.assertDeployableWorktree.mockResolvedValue();
    mocks.prepareDeployCheckout.mockResolvedValue('/source');
    mocks.publishDeploymentSource.mockResolvedValue({
      tag: 'deploy/v1',
      commit: 'source-commit',
      repoPath: 'apps/example',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.rm(mocks.root, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(mocks.root, { recursive: true, force: true });
  });

  it('publishes one activation event after a normal successful deployment', async () => {
    const id = 'normal-deploy';
    const app = appState(id, {
      status: 'draft',
      currentDeploymentId: null,
      capabilities: null,
      backendMode: null,
      dataActivationId: null,
    });
    mocks.apps.set(id, app);
    mocks.buildApp.mockImplementationOnce(stageFrontendBuild);
    await fs.mkdir(`${mocks.root}/live`, { recursive: true });

    const result = await deployApp(id, {
      message: 'First deployment',
      sourceDir: '/source',
    });

    expect(result.compatibilityVersion).toBe(2);
    expect(mocks.deployments.get(result.deploymentId)).toMatchObject({
      compatibilityVersion: 2,
    });
    expect(app).toMatchObject({
      status: 'deployed',
      currentDeploymentId: result.deploymentId,
      dataActivationId: null,
    });
    expect(mocks.publishPlatformEvent).toHaveBeenCalledOnce();
    expect(mocks.publishPlatformEvent).toHaveBeenCalledWith({
      type: 'app.deployment.activated',
      appId: id,
      deploymentRevision: result.deploymentId,
    });
  });

  it('does not publish an activation event when a normal build fails', async () => {
    const id = 'normal-build-failure';
    const failure = new Error('build failed');
    mocks.apps.set(
      id,
      appState(id, {
        status: 'draft',
        currentDeploymentId: null,
        capabilities: null,
        backendMode: null,
        dataActivationId: null,
      }),
    );
    mocks.buildApp.mockRejectedValueOnce(failure);

    await expect(
      deployApp(id, { message: 'Broken deployment', sourceDir: '/source' }),
    ).rejects.toBe(failure);

    expect(mocks.publishPlatformEvent).not.toHaveBeenCalled();
  });

  it('publishes once when a committed deployment loses its COMMIT acknowledgement', async () => {
    const id = 'commit-ack-lost';
    const app = appState(id, {
      status: 'draft',
      currentDeploymentId: null,
      capabilities: null,
      backendMode: null,
      dataActivationId: null,
    });
    mocks.apps.set(id, app);
    mocks.buildApp.mockImplementationOnce(stageFrontendBuild);
    mocks.releaseCommitAckFailure = new Error('connection lost after COMMIT');
    await fs.mkdir(`${mocks.root}/live`, { recursive: true });

    const result = await deployApp(id, {
      message: 'Committed deployment',
      sourceDir: '/source',
    });

    expect(app.currentDeploymentId).toBe(result.deploymentId);
    expect(mocks.publishPlatformEvent).toHaveBeenCalledOnce();
    expect(mocks.publishPlatformEvent).toHaveBeenCalledWith({
      type: 'app.deployment.activated',
      appId: id,
      deploymentRevision: result.deploymentId,
    });
  });

  it('clears a committed release fence with an exact deployment CAS', async () => {
    const app = appState('committed', {
      currentDeploymentId: 'deployment-pending',
    });
    mocks.apps.set('committed', app);
    mocks.deployments.set(
      'deployment-pending',
      deploymentState('deployment-pending', 'committed'),
    );

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBeNull();
    expect(mocks.stopApp).toHaveBeenCalledWith('committed');
    expect(mocks.publishPlatformEvent).toHaveBeenCalledOnce();
    expect(mocks.publishPlatformEvent).toHaveBeenCalledWith({
      type: 'app.deployment.activated',
      appId: 'committed',
      deploymentRevision: 'deployment-pending',
    });
    expect(mocks.updates).toContainEqual({
      values: { dataActivationId: null },
      predicate: {
        op: 'and',
        predicates: [
          { op: 'eq', field: 'id', value: 'committed' },
          {
            op: 'eq',
            field: 'currentDeploymentId',
            value: 'deployment-pending',
          },
          {
            op: 'eq',
            field: 'dataActivationId',
            value: 'deployment-pending',
          },
        ],
      },
    });
  });

  it('retains a committed release fence when backup cleanup fails', async () => {
    const id = 'committed-cleanup-failure';
    const pendingId = 'deployment-pending';
    const backup = `${mocks.root}/live/${id}.bak-${pendingId}`;
    const cleanupFailure = new Error('committed backup cleanup failed');
    const app = appState(id, { currentDeploymentId: pendingId });
    mocks.apps.set(id, app);
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));
    await writeBuild(backup, 'deployment-current', 'previous deployment');
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === backup) throw cleanupFailure;
      return realRm(target, options);
    });

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBe(pendingId);
    expect(mocks.stopApp).not.toHaveBeenCalled();
    expect(mocks.publishPlatformEvent).not.toHaveBeenCalled();
    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ values: { dataActivationId: null } }),
    );
    await expect(fs.access(backup)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      `[apps] activation recovery failed for ${id}:`,
      cleanupFailure,
    );
  });

  it('retains Data DB ownership when clearing a rolled-back activation', async () => {
    const id = 'rolled-back-data-claim';
    const app = appState(id, {
      currentDeploymentId: null,
      capabilities: { backend: false, dataTable: false },
      dataDbName: `data_${id}`,
      dataSchemaHash: null,
    });
    mocks.apps.set(id, app);

    await reconcilePendingAppActivations();

    expect(app).toMatchObject({
      status: 'failed',
      dataDbName: `data_${id}`,
      dataActivationId: null,
    });
  });

  it('retains the fence when current deployment changes before finalization', async () => {
    const app = appState('raced', {
      currentDeploymentId: 'deployment-pending',
    });
    mocks.apps.set('raced', app);
    mocks.deployments.set(
      'deployment-pending',
      deploymentState('deployment-pending', 'raced'),
    );
    mocks.liveBuildMatchesDeployment.mockImplementation(async () => {
      app.currentDeploymentId = 'deployment-newer';
      return true;
    });

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBe('deployment-pending');
    expect(console.error).toHaveBeenCalledWith(
      '[apps] activation recovery failed for raced:',
      expect.objectContaining({
        message: expect.stringContaining('could not be finalized'),
      }),
    );
  });

  it('finalizes a committed Data migration after an explicit code rollback', async () => {
    const id = 'explicit-rollback';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: false, dataTable: true },
      dataSchemaHash: 'last-known-hash',
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(
      currentId,
      deploymentState(currentId, id, { dataSchemaHash: 'restored-code-hash' }),
    );
    mocks.deployments.set(
      pendingId,
      deploymentState(pendingId, id, { dataSchemaHash: 'migrated-hash' }),
    );
    mocks.recoverCurrentDataSchema.mockResolvedValue({
      schema: { version: 1, tables: {} },
      hash: 'migrated-hash',
    });

    await reconcilePendingAppActivations();

    expect(mocks.liveBuildMatchesDeployment).toHaveBeenCalledWith(
      id,
      currentId,
    );
    expect(mocks.recoverCurrentDataSchema).toHaveBeenCalledWith(id);
    expect(mocks.stopApp).toHaveBeenCalledWith(id);
    expect(app).toMatchObject({
      currentDeploymentId: currentId,
      dataActivationId: null,
      dataSchemaHash: 'migrated-hash',
      status: 'deployed',
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('retains a restored activation fence when backup cleanup fails', async () => {
    const id = 'explicit-rollback-cleanup-failure';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const backup = `${mocks.root}/live/${id}.bak-${pendingId}`;
    const cleanupFailure = new Error('restored backup cleanup failed');
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: false, dataTable: true },
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));
    await writeBuild(backup, currentId, 'restored deployment');
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === backup) throw cleanupFailure;
      return realRm(target, options);
    });

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBe(pendingId);
    await expect(fs.access(backup)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      `[apps] activation recovery failed for ${id}:`,
      cleanupFailure,
    );
  });

  it('restarts a restored long-running backend before recovery returns', async () => {
    const id = 'explicit-rollback-backend';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: true, dataTable: true },
      backendMode: 'long-running',
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));

    await reconcilePendingAppActivations();

    expect(mocks.stopApp).toHaveBeenCalledWith(id);
    expect(mocks.setKeepAlive).toHaveBeenCalledWith(id, true);
    expect(mocks.ensureAppRunning).toHaveBeenCalledWith(id, currentId);
    expect(app.dataActivationId).toBeNull();
  });

  it('keeps restored backend recovery finalized when its warm start fails', async () => {
    const id = 'explicit-rollback-cold';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: true, dataTable: true },
      backendMode: 'long-running',
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));
    mocks.ensureAppRunning.mockRejectedValueOnce(new Error('boot failed'));

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBeNull();
    expect(mocks.setKeepAlive).toHaveBeenCalledWith(id, true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('re-arms a restored backend when activation finalization fails', async () => {
    const id = 'explicit-rollback-finalize-failure';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: true, dataTable: true },
      backendMode: 'long-running',
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));
    mocks.appUpdateFailure = new Error('platform connection lost');

    await reconcilePendingAppActivations();

    expect(mocks.stopApp).toHaveBeenCalledWith(id);
    expect(mocks.setKeepAlive).toHaveBeenCalledWith(id, true);
    expect(mocks.ensureAppRunning).toHaveBeenCalledWith(id, currentId);
    expect(console.error).toHaveBeenCalledWith(
      `[apps] activation recovery failed for ${id}:`,
      mocks.appUpdateFailure,
    );
  });

  it('keeps the restored backend running when a retry build fails', async () => {
    const id = 'explicit-rollback-retry';
    const currentId = 'deployment-restored';
    const pendingId = 'deployment-pending';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: currentId,
      capabilities: { backend: true, dataTable: true },
      backendMode: 'long-running',
      dataActivationId: pendingId,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    mocks.deployments.set(pendingId, deploymentState(pendingId, id));
    mocks.buildApp.mockRejectedValueOnce(new Error('retry build failed'));

    await expect(
      deployApp(id, { message: 'Retry deployment', sourceDir: '/source' }),
    ).rejects.toThrow('retry build failed');

    expect(mocks.setKeepAlive).toHaveBeenCalledWith(id, true);
    expect(mocks.ensureAppRunning).toHaveBeenCalledWith(id, currentId);
    expect(mocks.stopApp).toHaveBeenCalledOnce();
    expect(mocks.publishPlatformEvent).not.toHaveBeenCalled();
  });

  it('leaves durable App status unchanged when build validation fails', async () => {
    const id = 'source-validation-failure';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: 'deployment-current',
      dataActivationId: null,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(
      'deployment-current',
      deploymentState('deployment-current', id),
    );
    mocks.buildApp.mockRejectedValueOnce(
      new Error('Source validation failed during deno check'),
    );

    await expect(
      deployApp(id, { message: 'Broken source', sourceDir: '/source' }),
    ).rejects.toThrow('Source validation failed during deno check');

    expect(app.status).toBe('deployed');
    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ values: { status: 'building' } }),
    );
    expect(mocks.applyDataMigration).not.toHaveBeenCalled();
  });

  it('does not reinterpret a pre-existing building status after build failure', async () => {
    const id = 'preexisting-building-status';
    const app = appState(id, {
      status: 'building',
      currentDeploymentId: 'deployment-current',
      dataActivationId: null,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(
      'deployment-current',
      deploymentState('deployment-current', id),
    );
    mocks.buildApp.mockRejectedValueOnce(
      new Error('Source validation failed during deno check'),
    );

    await expect(
      deployApp(id, { message: 'Retry invalid source', sourceDir: '/source' }),
    ).rejects.toThrow('Source validation failed during deno check');

    expect(app.status).toBe('building');
    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ values: { status: 'deployed' } }),
    );
    expect(mocks.updates).not.toContainEqual(
      expect.objectContaining({ values: { status: 'failed' } }),
    );
  });

  it('does not overwrite an archive committed while the build was running', async () => {
    const id = 'archive-during-build';
    const app = appState(id, {
      status: 'deployed',
      currentDeploymentId: 'deployment-current',
      dataActivationId: null,
    });
    mocks.apps.set(id, app);
    mocks.deployments.set(
      'deployment-current',
      deploymentState('deployment-current', id),
    );
    mocks.buildApp.mockImplementationOnce(async () => {
      app.status = 'archived';
      return {
        source: {
          name: 'Archived during build',
          description: '',
          capabilities: {
            database: false,
            frontend: false,
            widgets: false,
            backend: false,
            cron: false,
            webhook: false,
            storage: false,
            kv: false,
            dataTable: false,
          },
          backendMode: 'serverless',
          workflows: [],
        },
        normalized: { workflows: [], cron: [] },
        log: '',
      };
    });

    await expect(
      deployApp(id, { message: 'Concurrent archive', sourceDir: '/source' }),
    ).rejects.toThrow(/changed state while its deployment was building/);

    expect(app.status).toBe('archived');
    expect(mocks.applyDataMigration).not.toHaveBeenCalled();
    expect(mocks.updates).toContainEqual(
      expect.objectContaining({
        values: { status: 'building' },
        predicate: {
          op: 'and',
          predicates: [
            { op: 'eq', field: 'id', value: id },
            { op: 'eq', field: 'status', value: 'deployed' },
          ],
        },
      }),
    );
  });

  it('removes a superseded pending artifact before a retry claims the fence', async () => {
    const id = 'superseded-artifact';
    const { app, pendingArtifact, pendingId } =
      await arrangeSupersededPendingArtifact(id);
    const migrationFailure = new Error('stop after claiming retry fence');
    mocks.applyDataMigration.mockImplementationOnce(async () => {
      await expect(fs.access(pendingArtifact)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(app.dataActivationId).not.toBe(pendingId);
      throw migrationFailure;
    });

    await expect(
      deployApp(id, { message: 'Retry deployment', sourceDir: '/source' }),
    ).rejects.toBe(migrationFailure);

    await expect(fs.access(pendingArtifact)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(app.dataActivationId).not.toBe(pendingId);
  });

  it('keeps the old fence when superseded artifact cleanup fails', async () => {
    const id = 'superseded-artifact-cleanup-failure';
    const { app, pendingArtifact, pendingId } =
      await arrangeSupersededPendingArtifact(id);
    const cleanupFailure = new Error('superseded artifact cleanup failed');
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === pendingArtifact) throw cleanupFailure;
      return realRm(target, options);
    });

    await expect(
      deployApp(id, { message: 'Retry deployment', sourceDir: '/source' }),
    ).rejects.toBe(cleanupFailure);

    expect(app.dataActivationId).toBe(pendingId);
    expect(mocks.applyDataMigration).not.toHaveBeenCalled();
    await expect(fs.access(pendingArtifact)).resolves.toBeUndefined();
  });

  it('persists Data DB ownership before a migration can fail', async () => {
    const id = 'claim-before-migration';
    const app = appState(id, {
      status: 'draft',
      currentDeploymentId: null,
      capabilities: null,
      manifest: null,
      backendMode: null,
      dataDbName: null,
      dataSchemaHash: null,
      dataActivationId: null,
    });
    const failure = new Error('migration failed after provisioning');
    mocks.apps.set(id, app);
    mocks.buildApp.mockImplementationOnce(async (_id, rawOptions) => {
      const { outputDir } = rawOptions as { outputDir: string };
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'index.html'), 'built', 'utf8');
      return {
        source: {
          name: 'Claim test',
          description: '',
          capabilities: {
            database: false,
            frontend: true,
            widgets: false,
            backend: false,
            cron: false,
            webhook: false,
            kv: false,
            dataTable: true,
          },
          backendMode: 'serverless',
          workflows: [],
        },
        normalized: { workflows: [], cron: [] },
        dataSchema: { version: 1, tables: {} },
        log: '',
      };
    });
    mocks.applyDataMigration.mockImplementationOnce(async () => {
      expect(app.dataDbName).toBe(`data_${id}`);
      throw failure;
    });

    await expect(
      deployApp(id, { message: 'Claim Data DB', sourceDir: '/source' }),
    ).rejects.toBe(failure);

    expect(app).toMatchObject({
      status: 'failed',
      currentDeploymentId: null,
      capabilities: null,
      manifest: null,
      backendMode: null,
      dataDbName: `data_${id}`,
      dataActivationId: null,
    });
  });

  it('retains the fence when the pending release outcome cannot be read', async () => {
    const app = appState('unknown');
    mocks.apps.set('unknown', app);
    mocks.deploymentReadFailures.add('unknown');

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBe('deployment-pending');
    expect(mocks.updates).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(
      '[apps] activation recovery failed for unknown:',
      expect.objectContaining({
        message: 'Deployment outcome for unknown is unavailable',
      }),
    );
  });

  it('retains a rolled-back fence when pending artifact cleanup fails', async () => {
    const id = 'rolled-back-artifact-cleanup-failure';
    const currentId = 'deployment-current';
    const pendingId = 'deployment-pending';
    const live = `${mocks.root}/live/${id}`;
    const backup = `${live}.bak-${pendingId}`;
    const pendingArtifact = `${mocks.root}/artifacts/${id}/${pendingId}`;
    const cleanupFailure = new Error('pending artifact cleanup failed');
    const app = appState(id, { currentDeploymentId: currentId });
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    await writeBuild(live, pendingId, 'unrecorded deployment');
    await writeBuild(backup, currentId, 'current deployment');
    await writeBuild(pendingArtifact, pendingId, 'pending artifact');
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === pendingArtifact) throw cleanupFailure;
      return realRm(target, options);
    });

    await reconcilePendingAppActivations();

    expect(app.dataActivationId).toBe(pendingId);
    await expect(fs.access(pendingArtifact)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(live, 'app', 'index.html'), 'utf8'),
    ).resolves.toBe('current deployment');
    expect(console.error).toHaveBeenCalledWith(
      `[apps] activation recovery failed for ${id}:`,
      cleanupFailure,
    );
  });

  it('rejects a mismatched backup marker and restores the immutable build', async () => {
    const id = 'fallback';
    const currentId = 'deployment-current';
    const pendingId = 'deployment-pending';
    const live = path.join(mocks.root, 'live', id);
    const backup = `${live}.bak-${pendingId}`;
    const artifact = path.join(mocks.root, 'artifacts', id, currentId);
    const app = appState(id);
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    await writeBuild(live, pendingId, 'unrecorded live');
    await writeBuild(backup, 'deployment-stale', 'stale backup');
    await writeBuild(artifact, currentId, 'immutable current');
    mocks.buildMatchesDeployment
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await reconcilePendingAppActivations();

    await expect(
      fs.readFile(path.join(live, 'app', 'index.html'), 'utf8'),
    ).resolves.toBe('immutable current');
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(app.dataActivationId).toBeNull();
  });

  it('does not re-authenticate a damaged modern snapshot during recovery', async () => {
    const id = 'damaged-modern';
    const currentId = 'deployment-current';
    const pendingId = 'deployment-pending';
    const live = path.join(mocks.root, 'live', id);
    const artifact = path.join(mocks.root, 'artifacts', id, currentId);
    const app = appState(id);
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    await writeBuild(live, pendingId, 'unrecorded live');
    await fs.mkdir(path.join(artifact, 'app'), { recursive: true });
    await fs.writeFile(
      path.join(artifact, 'app', 'index.html'),
      'damaged snapshot',
      'utf8',
    );
    mocks.buildMatchesDeployment.mockResolvedValueOnce(false);

    await reconcilePendingAppActivations();

    await expect(
      fs.readFile(path.join(live, 'app', 'index.html'), 'utf8'),
    ).resolves.toBe('unrecorded live');
    expect(mocks.buildMatchesDeployment).toHaveBeenCalledWith(
      id,
      currentId,
      artifact,
    );
    expect(app.dataActivationId).toBe(pendingId);
  });

  it('restores a markerless backup for a genuine legacy deployment', async () => {
    const id = 'legacy-backup';
    const currentId = 'deployment-current';
    const pendingId = 'deployment-pending';
    const live = path.join(mocks.root, 'live', id);
    const backup = `${live}.bak-${pendingId}`;
    const app = appState(id);
    mocks.apps.set(id, app);
    mocks.deployments.set(currentId, deploymentState(currentId, id));
    await writeBuild(live, pendingId, 'unrecorded live');
    await fs.mkdir(path.join(backup, 'app'), { recursive: true });
    await fs.writeFile(
      path.join(backup, 'app', 'index.html'),
      'legacy current',
      'utf8',
    );

    await reconcilePendingAppActivations();

    await expect(
      fs.readFile(path.join(live, 'app', 'index.html'), 'utf8'),
    ).resolves.toBe('legacy current');
    expect(mocks.buildMatchesDeployment).toHaveBeenCalledWith(
      id,
      currentId,
      backup,
    );
    expect(app.dataActivationId).toBeNull();
  });

  it('holds the app and cutover locks independently for every startup item', async () => {
    for (const id of ['first', 'second']) {
      mocks.apps.set(
        id,
        appState(id, { currentDeploymentId: 'deployment-pending' }),
      );
    }

    await reconcilePendingAppActivations();

    expect(mocks.events).toEqual([
      'app:start:first',
      'cutover:start:first',
      'db:first',
      'cutover:end:first',
      'app:end:first',
      'app:start:second',
      'cutover:start:second',
      'db:second',
      'cutover:end:second',
      'app:end:second',
    ]);
    expect(mocks.heldAppLocks).toHaveLength(0);
    expect(mocks.heldCutoverLocks).toHaveLength(0);
  });
});
