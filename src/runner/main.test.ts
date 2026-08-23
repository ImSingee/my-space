import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const { abortSession, listSessionIds, removeSession, sockets } = vi.hoisted(
  () => ({
    abortSession: vi.fn<(sessionId: string) => Promise<void>>(),
    listSessionIds: vi.fn<() => Promise<string[]>>(),
    removeSession: vi.fn<(sessionId: string) => Promise<void>>(),
    sockets: [] as Array<EventEmitter & { sent: Record<string, unknown>[] }>,
  }),
);

vi.mock('ws', () => ({
  WebSocket: class extends EventEmitter {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    sent: Record<string, unknown>[] = [];

    constructor() {
      super();
      sockets.push(this);
    }

    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
  },
}));
vi.mock('~env', () => ({
  getAgentRunnerEnv: () => ({
    appUrl: 'https://app.example.test',
    platformUrl: 'https://platform.example.test',
    token: 'runner-token',
    runnerId: 'runner-test',
    wsUrl: 'ws://platform.example.test/runner',
  }),
}));
vi.mock('~agent/shell-sandbox', () => ({
  initializeAgentSandbox: vi.fn<() => void>(),
}));
vi.mock('~agent/local-sources', () => ({
  withSourceWorkspaceLock: vi.fn<
    (sessionId: string, task: () => Promise<unknown>) => Promise<unknown>
  >(async (_sessionId, task) => task()),
}));
vi.mock('./workspace-cleanup', () => ({
  listLocalWorkspaceSessionIds: listSessionIds,
  removeSessionWorkspace: removeSession,
}));
vi.mock('./platform-rest', () => ({ createPlatformRestClient: () => ({}) }));
vi.mock('./executor', () => ({
  RunnerExecutor: class {
    activeCount = 0;
    activeRunIds() {
      return [];
    }
    abortSession = abortSession;
    abortStale() {}
    resendPending() {}
    abortAll() {}
  },
}));

beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
  listSessionIds.mockResolvedValue([]);
  removeSession.mockResolvedValue();
  abortSession.mockResolvedValue();
  vi.resetModules();
});

it('reports only session roots and removes stale conversations before ready', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  listSessionIds.mockResolvedValue(['session-present']);

  await import('./main');
  const socket = sockets[0];
  expect(socket).toBeDefined();
  socket.emit('open');
  await vi.waitFor(() =>
    expect(socket.sent).toContainEqual({
      type: 'runner.hello',
      runnerId: 'runner-test',
      protocolVersion: 9,
      activeRunIds: [],
      workspaceSessionIds: ['session-present'],
    }),
  );

  socket.emit(
    'message',
    JSON.stringify({
      type: 'hub.hello_ack',
      resumedRunIds: [],
      staleRunIds: [],
      staleWorkspaceSessionIds: ['session-deleted'],
    }),
  );

  await vi.waitFor(() =>
    expect(socket.sent).toContainEqual({ type: 'runner.ready' }),
  );
  expect(abortSession).toHaveBeenCalledWith('session-deleted');
  expect(removeSession).toHaveBeenCalledWith('session-deleted');
  expect(abortSession.mock.invocationCallOrder[0]).toBeLessThan(
    removeSession.mock.invocationCallOrder[0] as number,
  );
});

it('never logs malformed transient environment payloads', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const canary = 'plaintext-canary-never-log';

  await import('./main');
  const socket = sockets[0];
  expect(socket).toBeDefined();
  socket.emit(
    'message',
    `{"type":"run.env","entries":[{"key":"TOKEN","value":"${canary}`,
  );
  await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(canary);
  expect(consoleError).toHaveBeenCalledWith('[runner] invalid hub message.');
});
