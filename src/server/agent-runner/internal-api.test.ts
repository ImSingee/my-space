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
    vi.fn<(sessionId: string, handle: string) => Promise<{ appId: string }>>(),
  createApp:
    vi.fn<
      (
        input: CreateAppInput,
        context?: CreateAppContext,
      ) => Promise<CreateAppResult>
    >(),
  resolveAppId: vi.fn<(handle: string) => Promise<string | null>>(),
  queryAppDataTable:
    vi.fn<
      (
        id: string,
        input: ParsedQueryAppDataTableRequest,
        signal?: AbortSignal,
      ) => Promise<QueryAppDataTableResponse>
    >(),
}));

vi.mock('~server/agent-session-apps', () => ({
  associateAgentSessionApp: mocks.associateAgentSessionApp,
}));

vi.mock('~server/apps/scaffold', () => ({ createApp: mocks.createApp }));

vi.mock('~server/apps/access', () => ({
  resolveAppId: mocks.resolveAppId,
}));

vi.mock('~server/apps/query-data-table', () => ({
  queryAppDataTable: mocks.queryAppDataTable,
}));

const { handleInternalApiRequest } = await import('./internal-api');

function request(
  url = '/internal/api/apps/demo-app/query-data-table',
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

beforeEach(() => {
  mocks.associateAgentSessionApp.mockReset();
  mocks.createApp.mockReset();
  mocks.resolveAppId.mockReset();
  mocks.resolveAppId.mockResolvedValue('app-id');
  mocks.queryAppDataTable.mockReset();
});

describe('Agent Runner conversation App association internal API', () => {
  it('associates an existing App by id-or-slug handle', async () => {
    const req = request(
      '/internal/api/agent-sessions/session-one/apps/mutable-slug',
    );
    const res = response();
    mocks.associateAgentSessionApp.mockResolvedValue({
      appId: 'canonical-app',
    });

    await handleInternalApiRequest(req, res);

    expect(mocks.associateAgentSessionApp).toHaveBeenCalledWith(
      'session-one',
      'mutable-slug',
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
      expect(mocks.resolveAppId).toHaveBeenCalled();
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

  it('remembers a raw SQL disconnect while resolving the App', async () => {
    const req = request();
    const res = response();
    let resolveApp!: (id: string) => void;
    mocks.resolveAppId.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveApp = resolve;
      }),
    );
    mocks.queryAppDataTable.mockResolvedValue({
      action: 'raw_sql',
      results: [],
      truncated: false,
    });

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => expect(mocks.resolveAppId).toHaveBeenCalled());
    res.emit('close');
    resolveApp('app-id');
    await vi.waitFor(() => {
      expect(req.listenerCount('data')).toBeGreaterThan(0);
    });
    sendBody(req, { action: 'raw_sql', sql: 'select 1' });
    await handling;

    const signal = mocks.queryAppDataTable.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(true);
  });

  it('rejects an aborted partial body while resolving the App', async () => {
    const req = request();
    const res = response();
    let resolveApp!: (id: string) => void;
    mocks.resolveAppId.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveApp = resolve;
      }),
    );

    const handling = handleInternalApiRequest(req, res);
    await vi.waitFor(() => {
      expect(req.listenerCount('data')).toBeGreaterThan(0);
    });
    req.emit('data', Buffer.from('{"action":"raw_sql"'));
    req.emit('aborted');
    resolveApp('app-id');
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
      expect(mocks.resolveAppId).toHaveBeenCalled();
    });
    await Promise.resolve();
    sendBody(req, { action: 'inspect' });
    await handling;

    expect(mocks.queryAppDataTable).toHaveBeenCalledWith(
      'app-id',
      { action: 'inspect' },
      undefined,
    );
  });
});
