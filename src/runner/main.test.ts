import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }));

vi.mock('ws', () => ({
  WebSocket: class extends EventEmitter {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;

    constructor() {
      super();
      sockets.push(this);
    }

    send() {}
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
  acquireSourceWorkspaceBarrier: vi.fn<() => Promise<never>>(),
}));
vi.mock('./workspace-cleanup', () => ({
  inspectLocalWorkspaces: vi.fn<() => Promise<never>>(),
  reconcileLocalWorkspaces: vi.fn<() => Promise<void>>(),
  removeEntityWorkspaces: vi.fn<() => Promise<void>>(),
  removeSessionWorkspace: vi.fn<() => Promise<void>>(),
}));
vi.mock('./platform-rest', () => ({ createPlatformRestClient: () => ({}) }));
vi.mock('./executor', () => ({
  RunnerExecutor: class {
    activeCount = 0;
    activeRunIds() {
      return [];
    }
    abortAll() {}
  },
}));

beforeEach(() => {
  sockets.length = 0;
  vi.resetModules();
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
