import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

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

const agentRuns = await import('~server/agent-runs');
const { connectedRunnerCount, handleRunnerSocket, listConnectedRunners } =
  await import('~server/agent-runner/hub');

/** Minimal stand-in for the `ws` socket surface the hub touches. */
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: { type: string }[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  terminate() {
    this.readyState = 3;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

async function connectRunner(runnerId: string, activeRunIds: string[] = []) {
  const socket = new FakeSocket();
  handleRunnerSocket(socket.asWebSocket());
  socket.emit(
    'message',
    JSON.stringify({
      type: 'runner.hello',
      runnerId,
      protocolVersion: 1,
      activeRunIds,
    }),
  );
  await vi.waitFor(() =>
    expect(socket.sent.some((m) => m.type === 'hub.hello_ack')).toBe(true),
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
  it('lists a registered runner with its hello metadata', async () => {
    await connectRunner('runner-a');

    expect(connectedRunnerCount()).toBe(1);
    const [info] = listConnectedRunners();
    expect(info).toEqual({
      runnerId: 'runner-a',
      protocolVersion: 1,
      activeRunCount: 0,
      connectedAt: '2026-07-07T10:00:00.000Z',
      lastSeenAt: '2026-07-07T10:00:00.000Z',
    });
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
});
