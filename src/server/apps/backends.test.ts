import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

// The real runtime module spawns Deno processes; the backends store only
// orchestrates it, so replace it with observable fakes.
vi.mock('~server/apps/runtime', () => {
  type Runtime = typeof import('~server/apps/runtime');
  return {
    getBackendRuntimeView: vi.fn<Runtime['getBackendRuntimeView']>(() => ({
      state: 'stopped' as const,
      pid: null,
      port: null,
      startedAt: null,
      stoppedAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: null,
      restartCount: 0,
      keepAlive: false,
    })),
    startAppBackend: vi.fn<Runtime['startAppBackend']>(async () => {}),
    restartAppBackend: vi.fn<Runtime['restartAppBackend']>(async () => {}),
    stopApp: vi.fn<Runtime['stopApp']>(),
  };
});

const { db, schema } = await import('~/db');
const runtime = await import('~server/apps/runtime');
const {
  listAppBackends,
  restartBackendForApp,
  startBackendForApp,
  stopBackendForApp,
} = await import('~server/apps/backends');

const BACKEND_CAPS = {
  database: false,
  frontend: false,
  widgets: false,
  backend: true,
  cron: false,
  webhook: false,
  kv: false,
  userscripts: false,
};

async function seedApp(
  id: string,
  overrides: Partial<typeof schema.apps.$inferInsert> = {},
) {
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: `App ${id}`,
    status: 'deployed',
    capabilities: BACKEND_CAPS,
    currentDeploymentId: `dep-${id}`,
    ...overrides,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.apps);
});

describe('listAppBackends', () => {
  it('lists only non-archived, deployed, backend-capable apps', async () => {
    await seedApp('runnable');
    await seedApp('long', { backendMode: 'long-running' });
    await seedApp('archived', { status: 'archived' });
    await seedApp('undeployed', { currentDeploymentId: null });
    await seedApp('frontend-only', {
      capabilities: { ...BACKEND_CAPS, backend: false },
    });
    await seedApp('no-caps', { capabilities: null });

    const backends = await listAppBackends();
    expect(backends.map((b) => b.id).sort()).toEqual(['long', 'runnable']);
  });

  it('defaults the mode to serverless and carries the runtime view', async () => {
    await seedApp('plain');
    await seedApp('long', { backendMode: 'long-running' });

    const backends = await listAppBackends();
    const byId = new Map(backends.map((b) => [b.id, b]));
    expect(byId.get('plain')?.mode).toBe('serverless');
    expect(byId.get('long')?.mode).toBe('long-running');
    expect(byId.get('plain')?.runtime.state).toBe('stopped');
  });

  it('serializes runtime timestamps as ISO strings', async () => {
    await seedApp('timed');
    vi.mocked(runtime.getBackendRuntimeView).mockReturnValueOnce({
      state: 'running',
      pid: 123,
      port: 4001,
      startedAt: 1_700_000_000_000,
      stoppedAt: 1_690_000_000_000,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: null,
      restartCount: 1,
      keepAlive: true,
    });

    const [backend] = await listAppBackends();
    expect(backend.runtime.startedAt).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
    expect(backend.runtime.stoppedAt).toBe(
      new Date(1_690_000_000_000).toISOString(),
    );
  });
});

describe('backend control guards', () => {
  it('rejects apps that do not exist', async () => {
    await expect(startBackendForApp('missing')).rejects.toThrow(
      'App not found.',
    );
  });

  it('rejects archived apps', async () => {
    await seedApp('gone', { status: 'archived' });
    await expect(startBackendForApp('gone')).rejects.toThrow('App not found.');
    expect(runtime.startAppBackend).not.toHaveBeenCalled();
  });

  it('rejects apps without the backend capability', async () => {
    await seedApp('static', {
      capabilities: { ...BACKEND_CAPS, backend: false },
    });
    await expect(restartBackendForApp('static')).rejects.toThrow(
      'This app has no backend.',
    );
    expect(runtime.restartAppBackend).not.toHaveBeenCalled();
  });

  it('rejects apps that were never deployed', async () => {
    await seedApp('draft', { status: 'draft', currentDeploymentId: null });
    await expect(stopBackendForApp('draft')).rejects.toThrow(
      'This app has never been deployed.',
    );
    expect(runtime.stopApp).not.toHaveBeenCalled();
  });
});

describe('backend controls', () => {
  it('start re-arms keep-alive for long-running apps only', async () => {
    await seedApp('long', { backendMode: 'long-running' });
    await seedApp('plain');

    await startBackendForApp('long');
    expect(runtime.startAppBackend).toHaveBeenLastCalledWith('long', {
      keepAlive: true,
    });

    await startBackendForApp('plain');
    expect(runtime.startAppBackend).toHaveBeenLastCalledWith('plain', {
      keepAlive: false,
    });
  });

  it('restart passes the same keep-alive contract', async () => {
    await seedApp('long', { backendMode: 'long-running' });
    await restartBackendForApp('long');
    expect(runtime.restartAppBackend).toHaveBeenCalledWith('long', {
      keepAlive: true,
    });
  });

  it('stop is idempotent for a backend that is not running', async () => {
    await seedApp('idle');
    const view = await stopBackendForApp('idle');
    expect(runtime.stopApp).toHaveBeenCalledWith('idle');
    expect(view.state).toBe('stopped');
  });
});
