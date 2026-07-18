import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type WorkspaceSourceClaim } from '~agent/protocol';

const GENERATION = '2026-07-12T00:00:00.000Z';

// The hub reaches into the run control plane on hello (reconcile) and ping
// (lease renewal); these tests only exercise connection bookkeeping, so stub
// the database-touching module out.
vi.mock('~server/agent-runs', () => {
  type AgentRuns = typeof import('~server/agent-runs');
  return {
    assignRunToRunner: vi.fn<AgentRuns['assignRunToRunner']>(async () => {}),
    reconcileRunnerRuns: vi.fn<AgentRuns['reconcileRunnerRuns']>(async () => ({
      resumed: [],
      stale: [],
      pendingAnswers: [],
    })),
    renewRunnerLeases: vi.fn<AgentRuns['renewRunnerLeases']>(async () => {}),
    ingestRunnerEvent: vi.fn<AgentRuns['ingestRunnerEvent']>(async () => 'ok'),
    completeRunFromRunner: vi.fn<AgentRuns['completeRunFromRunner']>(
      async () => {},
    ),
  };
});

vi.mock('~server/agent-workspaces', () => {
  type Workspaces = typeof import('~server/agent-workspaces');
  return {
    reconcileRunnerWorkspaces: vi.fn<Workspaces['reconcileRunnerWorkspaces']>(
      async () => ({
        staleSessionIds: [],
        staleSources: [],
      }),
    ),
  };
});

const agentRuns = await import('~server/agent-runs');
const agentWorkspaces = await import('~server/agent-workspaces');
const {
  broadcastEntityWorkspaceCleanup,
  broadcastSessionWorkspaceCleanup,
  connectedRunnerCount,
  handleRunnerSocket,
  listConnectedRunners,
} = await import('~server/agent-runner/hub');

/** Minimal stand-in for the `ws` socket surface the hub touches. */
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null =
    null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function connectRunner(
  runnerId: string,
  activeRunIds: string[] = [],
  workspaceSessionIds: string[] = [],
  workspaceSources: WorkspaceSourceClaim[] = [],
) {
  const socket = new FakeSocket();
  handleRunnerSocket(socket.asWebSocket());
  socket.emit(
    'message',
    JSON.stringify({
      type: 'runner.hello',
      runnerId,
      protocolVersion: PROTOCOL_VERSION,
      activeRunIds,
      workspaceSessionIds,
      workspaceSources,
    }),
  );
  await vi.waitFor(() =>
    expect(socket.sent.some((m) => m.type === 'hub.hello_ack')).toBe(true),
  );
  socket.emit('message', JSON.stringify({ type: 'runner.ready' }));
  await vi.waitFor(() =>
    expect(socket.sent.some((m) => m.type === 'hub.ready_ack')).toBe(true),
  );
  return socket;
}

beforeEach(() => {
  // The hub keeps its state on globalThis (dev-reload safety); start each
  // test from a clean slate.
  delete (globalThis as { __hatchRunnerHub__?: unknown }).__hatchRunnerHub__;
  vi.clearAllMocks();
  // Fake only Date so lastSeen deltas are deterministic; timers stay real
  // because the hub's async message handling relies on them (vi.waitFor).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-07T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runner connection snapshot', () => {
  it('rejects an older runner before it can use incompatible REST tools', async () => {
    const socket = new FakeSocket();
    handleRunnerSocket(socket.asWebSocket());
    socket.emit(
      'message',
      JSON.stringify({
        type: 'runner.hello',
        runnerId: 'old-runner',
        protocolVersion: PROTOCOL_VERSION - 1,
        activeRunIds: [],
        workspaceSessionIds: [],
        workspaceSources: [],
      }),
    );

    await vi.waitFor(() =>
      expect(socket.closed).toEqual({
        code: 1008,
        reason: `Unsupported protocol version ${PROTOCOL_VERSION - 1}.`,
      }),
    );
    expect(connectedRunnerCount()).toBe(0);
    expect(agentWorkspaces.reconcileRunnerWorkspaces).not.toHaveBeenCalled();
  });

  it('lists a registered runner with its hello metadata', async () => {
    await connectRunner('runner-a');

    expect(connectedRunnerCount()).toBe(1);
    const [info] = listConnectedRunners();
    expect(info).toMatchObject({
      runnerId: 'runner-a',
      protocolVersion: PROTOCOL_VERSION,
      activeRunCount: 0,
      connectedAt: '2026-07-07T10:00:00.000Z',
    });
    expect(new Date(info.lastSeenAt).getTime()).toBeGreaterThanOrEqual(
      new Date(info.connectedAt).getTime(),
    );
  });

  it('counts runs reclaimed on reconnect as active', async () => {
    vi.mocked(agentRuns.reconcileRunnerRuns).mockResolvedValueOnce({
      resumed: ['run-1', 'run-2'],
      stale: [],
      pendingAnswers: [],
    });
    await connectRunner('runner-a', ['run-1', 'run-2']);

    expect(listConnectedRunners()[0].activeRunCount).toBe(2);
  });

  it('bumps lastSeenAt on a ping and on other valid messages', async () => {
    const socket = await connectRunner('runner-a');

    vi.setSystemTime(new Date('2026-07-07T10:00:15.000Z'));
    socket.emit('message', JSON.stringify({ type: 'runner.ping' }));
    await vi.waitFor(() =>
      expect(socket.sent.some((m) => m.type === 'hub.pong')).toBe(true),
    );
    expect(agentRuns.renewRunnerLeases).toHaveBeenCalledWith('runner-a');
    expect(listConnectedRunners()[0]).toMatchObject({
      connectedAt: '2026-07-07T10:00:00.000Z',
      lastSeenAt: '2026-07-07T10:00:15.000Z',
    });

    vi.setSystemTime(new Date('2026-07-07T10:00:30.000Z'));
    socket.emit(
      'message',
      JSON.stringify({
        type: 'run.event',
        runId: 'run-1',
        runnerSeq: 1,
        event: { type: 'text', text: 'hi' },
      }),
    );
    await vi.waitFor(() =>
      expect(listConnectedRunners()[0].lastSeenAt).toBe(
        '2026-07-07T10:00:30.000Z',
      ),
    );
  });

  it('removes a runner from the snapshot when its socket closes', async () => {
    const socket = await connectRunner('runner-a');
    expect(connectedRunnerCount()).toBe(1);

    socket.emit('close');

    expect(connectedRunnerCount()).toBe(0);
    expect(listConnectedRunners()).toEqual([]);
  });

  it('keeps one entry per runner id when the same runner reconnects', async () => {
    await connectRunner('runner-a');
    vi.setSystemTime(new Date('2026-07-07T10:05:00.000Z'));
    await connectRunner('runner-a');

    expect(connectedRunnerCount()).toBe(1);
    expect(listConnectedRunners()[0].connectedAt).toBe(
      '2026-07-07T10:05:00.000Z',
    );
  });

  it('returns the Platform reconciliation snapshot on reconnect', async () => {
    vi.mocked(agentWorkspaces.reconcileRunnerWorkspaces).mockResolvedValueOnce({
      staleSessionIds: ['deleted-session'],
      staleSources: [
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'deleted-app',
          generation: GENERATION,
        },
      ],
    });

    const socket = await connectRunner(
      'runner-a',
      [],
      ['active-session', 'deleted-session'],
      [
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'deleted-app',
          generation: GENERATION,
        },
      ],
    );

    expect(agentWorkspaces.reconcileRunnerWorkspaces).toHaveBeenCalledWith({
      sessionIds: ['active-session', 'deleted-session'],
      sources: [
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'deleted-app',
          generation: GENERATION,
        },
      ],
    });
    expect(socket.sent).toContainEqual({
      type: 'hub.hello_ack',
      resumedRunIds: [],
      staleRunIds: [],
      staleWorkspaceSessionIds: ['deleted-session'],
      staleWorkspaceSources: [
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'deleted-app',
          generation: GENERATION,
        },
      ],
    });
  });

  it('receives cleanup broadcasts while registration is still pending', async () => {
    let finish:
      | ((value: { staleSessionIds: string[]; staleSources: [] }) => void)
      | undefined;
    vi.mocked(agentWorkspaces.reconcileRunnerWorkspaces).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const socket = new FakeSocket();
    handleRunnerSocket(socket.asWebSocket());
    socket.emit(
      'message',
      JSON.stringify({
        type: 'runner.hello',
        runnerId: 'runner-pending',
        protocolVersion: PROTOCOL_VERSION,
        activeRunIds: [],
        workspaceSessionIds: ['deleted-session'],
        workspaceSources: [],
      }),
    );
    await vi.waitFor(() =>
      expect(agentWorkspaces.reconcileRunnerWorkspaces).toHaveBeenCalledOnce(),
    );

    expect(connectedRunnerCount()).toBe(0);
    broadcastSessionWorkspaceCleanup('deleted-session');
    expect(socket.sent).toContainEqual({
      type: 'workspace.cleanup',
      scope: 'session',
      sessionId: 'deleted-session',
    });

    finish?.({ staleSessionIds: ['deleted-session'], staleSources: [] });
    await vi.waitFor(() =>
      expect(
        socket.sent.some((message) => message.type === 'hub.hello_ack'),
      ).toBe(true),
    );
    socket.emit('message', JSON.stringify({ type: 'runner.ready' }));
    await vi.waitFor(() => expect(connectedRunnerCount()).toBe(1));
  });

  it('broadcasts session and entity cleanup to every online runner', async () => {
    const first = await connectRunner('runner-a');
    const second = await connectRunner('runner-b');

    broadcastSessionWorkspaceCleanup('session-a');
    broadcastEntityWorkspaceCleanup('app', 'app-a', GENERATION);
    broadcastEntityWorkspaceCleanup('workflow', 'workflow-a', GENERATION);

    for (const socket of [first, second]) {
      expect(socket.sent).toEqual(
        expect.arrayContaining([
          {
            type: 'workspace.cleanup',
            scope: 'session',
            sessionId: 'session-a',
          },
          {
            type: 'workspace.cleanup',
            scope: 'app',
            id: 'app-a',
            generation: GENERATION,
          },
          {
            type: 'workspace.cleanup',
            scope: 'workflow',
            id: 'workflow-a',
            generation: GENERATION,
          },
        ]),
      );
    }
  });
});
