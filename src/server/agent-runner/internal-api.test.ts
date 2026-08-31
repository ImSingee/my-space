import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ParsedQueryAppDataTableRequest,
  QueryAppDataTableResponse,
} from '~agent/protocol';
import type {
  CreateAppContext,
  CreateAppInput,
  CreateAppResult,
} from '~server/apps/scaffold';

const mocks = vi.hoisted(() => ({
  associateAgentSessionApp:
    vi.fn<(sessionId: string, appId: string) => Promise<{ appId: string }>>(),
  createApp:
    vi.fn<
      (
        input: CreateAppInput,
        context?: CreateAppContext,
      ) => Promise<CreateAppResult>
    >(),
  findApp:
    vi.fn<
      (query: {
        where: { id: string };
      }) =>
        | Promise<{ id: string; createdAt?: Date } | undefined>
        | { id: string; createdAt?: Date }
        | undefined
    >(),
  getAppDetailForAgent: vi.fn<(appId: string) => Promise<unknown> | unknown>(),
  appMasterCommit:
    vi.fn<(appId: string) => Promise<string | null> | string | null>(),
  exportAppMasterBundle:
    vi.fn<(appId: string) => Promise<Buffer | null> | Buffer | null>(),
  stageAppBundleCheckout:
    vi.fn<
      (
        appId: string,
        bundle: Buffer,
      ) => Promise<{ dir: string; cleanup: () => Promise<void> | void }>
    >(),
  deployApp: vi.fn<(appId: string, options: unknown) => Promise<unknown>>(),
  appSlug: vi.fn<(appId: string) => Promise<string | null>>(),
  projectAppManifestUrls:
    vi.fn<(manifest: unknown, appId: string, slug: string) => unknown>(),
  rollbackAppToVersion:
    vi.fn<(appId: string, version: number) => Promise<unknown>>(),
  queryAppDatabase:
    vi.fn<
      (appId: string, sql: string, signal?: AbortSignal) => Promise<unknown>
    >(),
  queryAppKv: vi.fn<(appId: string, input: unknown) => Promise<unknown>>(),
  queryAppDataTable:
    vi.fn<
      (
        id: string,
        input: ParsedQueryAppDataTableRequest,
        signal?: AbortSignal,
      ) => Promise<QueryAppDataTableResponse>
    >(),
}));

vi.mock('~/db', () => ({
  db: { query: { apps: { findFirst: mocks.findApp } } },
}));

vi.mock('~server/agent-session-apps', () => ({
  associateAgentSessionApp: mocks.associateAgentSessionApp,
}));

vi.mock('~server/apps/scaffold', () => ({ createApp: mocks.createApp }));

vi.mock('~server/apps/access', () => ({
  appSlug: mocks.appSlug,
}));

vi.mock('~server/apps/inspect', () => ({
  getAppDetailForAgent: mocks.getAppDetailForAgent,
}));

vi.mock('~server/apps/git', () => ({
  appMasterCommit: mocks.appMasterCommit,
  exportAppMasterBundle: mocks.exportAppMasterBundle,
  stageAppBundleCheckout: mocks.stageAppBundleCheckout,
}));

vi.mock('~server/apps/deploy', () => ({ deployApp: mocks.deployApp }));

vi.mock('~server/apps/manifest', () => ({
  projectAppManifestUrls: mocks.projectAppManifestUrls,
}));

vi.mock('~server/apps/manage', () => ({
  rollbackAppToVersion: mocks.rollbackAppToVersion,
}));

vi.mock('~server/apps/query-db', () => ({
  queryAppDatabase: mocks.queryAppDatabase,
}));

vi.mock('~server/apps/query-kv', () => ({
  queryAppKv: mocks.queryAppKv,
}));

vi.mock('~server/apps/query-data-table', () => ({
  queryAppDataTable: mocks.queryAppDataTable,
}));

const { handleInternalApiRequest } = await import('./internal-api');

function request(
  url = '/internal/api/apps/immutable-app-id/query-data-table',
  method = 'POST',
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  return req;
}

function sendBody(req: http.IncomingMessage, body: unknown): void {
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
}

function response(): http.ServerResponse {
  const res = new EventEmitter() as http.ServerResponse;
  let ended = false;
  Object.defineProperty(res, 'writableEnded', {
    get: () => ended,
  });
  res.writeHead = vi.fn<() => http.ServerResponse>(
    () => res,
  ) as typeof res.writeHead;
  res.end = vi.fn<() => http.ServerResponse>(() => {
    ended = true;
    return res;
  }) as typeof res.end;
  return res;
}

async function callRoute(
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<http.ServerResponse> {
  const req = request(url, method);
  const res = response();
  const handling = handleInternalApiRequest(req, res);
  if (body !== undefined) {
    await vi.waitFor(() => {
      if (req.listenerCount('data') === 0) {
        throw new Error('Request body listener is not ready.');
      }
    });
    sendBody(req, body);
  }
  await handling;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findApp.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      where.id === 'immutable-app-id'
        ? {
            id: 'immutable-app-id',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
          }
        : undefined,
  );
  mocks.getAppDetailForAgent.mockImplementation(async (appId: string) =>
    appId === 'immutable-app-id'
      ? { id: appId, slug: 'mutable-slug', name: 'Example App' }
      : null,
  );
  mocks.appMasterCommit.mockResolvedValue('master-commit');
  mocks.exportAppMasterBundle.mockResolvedValue(Buffer.from('bundle'));
  mocks.stageAppBundleCheckout.mockResolvedValue({
    dir: '/tmp/staged-app',
    cleanup: vi.fn<() => void>(),
  });
  mocks.deployApp.mockResolvedValue({
    deploymentId: 'deployment-one',
    version: 1,
    compatibilityVersion: 2,
    normalized: { id: 'immutable-app-id' },
  });
  mocks.appSlug.mockResolvedValue('mutable-slug');
  mocks.projectAppManifestUrls.mockImplementation((manifest) => manifest);
  mocks.rollbackAppToVersion.mockResolvedValue({ version: 1 });
  mocks.queryAppDatabase.mockResolvedValue({ text: '[]', rowCount: 0 });
  mocks.queryAppKv.mockResolvedValue({
    action: 'list',
    items: [],
    nextCursor: null,
  });
  mocks.queryAppDataTable.mockResolvedValue({ action: 'inspect', data: null });
});

describe('Agent Runner conversation App association internal API', () => {
  it('forwards the immutable App id', async () => {
    const req = request(
      '/internal/api/agent-sessions/session-one/apps/immutable-app-id',
    );
    const res = response();
    mocks.associateAgentSessionApp.mockResolvedValue({
      appId: 'canonical-app',
    });

    await handleInternalApiRequest(req, res);

    expect(mocks.associateAgentSessionApp).toHaveBeenCalledWith(
      'session-one',
      'immutable-app-id',
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ appId: 'canonical-app' }),
    );
  });

  it('passes Runner-owned session identity separately when creating an App', async () => {
    const req = request('/internal/api/apps');
    const res = response();
    mocks.createApp.mockResolvedValue({
      id: 'created-app',
      slug: 'created-app',
      name: 'Created App',
      files: [],
    });

    const handling = handleInternalApiRequest(req, res);
    sendBody(req, {
      slug: 'created-app',
      name: 'Created App',
      sessionId: 'session-one',
    });
    await handling;

    expect(mocks.createApp).toHaveBeenCalledWith(
      { slug: 'created-app', name: 'Created App' },
      { sessionId: 'session-one' },
    );
  });

  it('returns 404 when the association path contains only an App slug', async () => {
    mocks.associateAgentSessionApp.mockRejectedValue(
      new (await import('~server/errors')).AppError(
        'App "mutable-slug" not found.',
        404,
      ),
    );

    const res = await callRoute(
      '/internal/api/agent-sessions/session-one/apps/mutable-slug',
      'POST',
    );

    expect(mocks.associateAgentSessionApp).toHaveBeenCalledWith(
      'session-one',
      'mutable-slug',
    );
    expect(res.writeHead).toHaveBeenCalledWith(404, {
      'content-type': 'application/json',
    });
  });
});

const appRouteCases = [
  {
    name: 'details',
    suffix: '',
    method: 'GET' as const,
    assertId: () =>
      expect(mocks.getAppDetailForAgent).toHaveBeenCalledWith(
        'immutable-app-id',
      ),
  },
  {
    name: 'source',
    suffix: '/source',
    method: 'GET' as const,
    assertId: () =>
      expect(mocks.appMasterCommit).toHaveBeenCalledWith('immutable-app-id'),
  },
  {
    name: 'deploy',
    suffix: '/deploy',
    method: 'POST' as const,
    body: {
      message: 'Deploy by id',
      generation: '2026-09-01T00:00:00.000Z',
      bundleBase64: Buffer.from('bundle').toString('base64'),
    },
    assertId: () =>
      expect(mocks.stageAppBundleCheckout).toHaveBeenCalledWith(
        'immutable-app-id',
        Buffer.from('bundle'),
      ),
  },
  {
    name: 'rollback',
    suffix: '/rollback',
    method: 'POST' as const,
    body: { version: 1 },
    assertId: () =>
      expect(mocks.rollbackAppToVersion).toHaveBeenCalledWith(
        'immutable-app-id',
        1,
      ),
  },
  {
    name: 'database query',
    suffix: '/query-db',
    method: 'POST' as const,
    body: { sql: 'select 1' },
    assertId: () =>
      expect(mocks.queryAppDatabase).toHaveBeenCalledWith(
        'immutable-app-id',
        'select 1',
        expect.any(AbortSignal),
      ),
  },
  {
    name: 'KV query',
    suffix: '/query-kv',
    method: 'POST' as const,
    body: { action: 'list' },
    assertId: () =>
      expect(mocks.queryAppKv).toHaveBeenCalledWith('immutable-app-id', {
        action: 'list',
        limit: 100,
        revealSecrets: false,
      }),
  },
  {
    name: 'Data Table query',
    suffix: '/query-data-table',
    method: 'POST' as const,
    body: { action: 'inspect' },
    assertId: () =>
      expect(mocks.queryAppDataTable).toHaveBeenCalledWith(
        'immutable-app-id',
        { action: 'inspect' },
        undefined,
      ),
  },
];

describe('Agent Runner ID-only App internal API', () => {
  it.each(appRouteCases)('serves $name by immutable id', async (route) => {
    const res = await callRoute(
      `/internal/api/apps/immutable-app-id${route.suffix}`,
      route.method,
      route.body,
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
    route.assertId();
  });

  it.each(appRouteCases)(
    'returns 404 for a slug-only $name path',
    async (route) => {
      const res = await callRoute(
        `/internal/api/apps/mutable-slug${route.suffix}`,
        route.method,
        route.suffix === '/deploy' || route.suffix === '/query-data-table'
          ? route.body
          : undefined,
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        'content-type': 'application/json',
      });
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({ error: 'App "mutable-slug" not found.' }),
      );
    },
  );

  it('accepts a legacy kebab-case immutable App id', async () => {
    mocks.getAppDetailForAgent.mockImplementation(async (appId: string) =>
      appId === 'legacy-kebab-id'
        ? { id: appId, slug: 'current-slug', name: 'Legacy App' }
        : null,
    );

    const res = await callRoute('/internal/api/apps/legacy-kebab-id', 'GET');

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/json',
    });
    expect(mocks.getAppDetailForAgent).toHaveBeenCalledWith('legacy-kebab-id');
  });
});

describe('Agent Runner Data Table internal API', () => {
  it('turns a closed raw SQL response into an AbortSignal', async () => {
    const req = request();
    const res = response();
    let capturedSignal: AbortSignal | undefined;
    let resolveQuery!: (response: QueryAppDataTableResponse) => void;
    mocks.queryAppDataTable.mockImplementation(
      (_id: string, _input: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<QueryAppDataTableResponse>((resolve) => {
          resolveQuery = resolve;
        });
      },
    );

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => {
      expect(mocks.findApp).toHaveBeenCalled();
    });
    await Promise.resolve();
    sendBody(req, {
      action: 'raw_sql',
      sql: 'select pg_sleep(60)',
      timeoutMs: 120_000,
    });
    await vi.waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    res.emit('close');
    expect(capturedSignal?.aborted).toBe(true);
    resolveQuery({ action: 'raw_sql', results: [], truncated: false });
    await handling;
  });

  it('remembers a raw SQL disconnect while looking up the App id', async () => {
    const req = request();
    const res = response();
    let resolveLookup!: (app: { id: string }) => void;
    mocks.findApp.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveLookup = resolve;
      }),
    );
    mocks.queryAppDataTable.mockResolvedValue({
      action: 'raw_sql',
      results: [],
      truncated: false,
    });

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => expect(mocks.findApp).toHaveBeenCalled());
    res.emit('close');
    resolveLookup({ id: 'immutable-app-id' });
    await vi.waitFor(() => {
      expect(req.listenerCount('data')).toBeGreaterThan(0);
    });
    sendBody(req, { action: 'raw_sql', sql: 'select 1' });
    await handling;

    const signal = mocks.queryAppDataTable.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(true);
  });

  it('rejects an aborted partial body while looking up the App id', async () => {
    const req = request();
    const res = response();
    let resolveLookup!: (app: { id: string }) => void;
    mocks.findApp.mockReturnValueOnce(
      new Promise<{ id: string }>((resolve) => {
        resolveLookup = resolve;
      }),
    );

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => {
      expect(req.listenerCount('data')).toBeGreaterThan(0);
    });
    req.emit('data', Buffer.from('{"action":"raw_sql"'));
    req.emit('aborted');
    resolveLookup({ id: 'immutable-app-id' });
    await handling;

    expect(mocks.queryAppDataTable).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(400, {
      'content-type': 'application/json',
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: 'Request body was aborted.' }),
    );
  });

  it('does not create a long-running abort signal for structured actions', async () => {
    const req = request();
    const res = response();
    mocks.queryAppDataTable.mockResolvedValue({
      action: 'inspect',
      data: null,
    } satisfies QueryAppDataTableResponse);

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => {
      expect(mocks.findApp).toHaveBeenCalled();
    });
    await Promise.resolve();
    sendBody(req, { action: 'inspect' });
    await handling;

    expect(mocks.queryAppDataTable).toHaveBeenCalledWith(
      'immutable-app-id',
      { action: 'inspect' },
      undefined,
    );
  });
});
