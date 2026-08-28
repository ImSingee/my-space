import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type RunStartPayload } from '~agent/protocol';

// The hub reaches into the run control plane on hello (reconcile) and ping
// (lease renewal); these tests only exercise connection bookkeeping, so stub
// the database-touching module out.
vi.mock('~server/agent-runs', () => {
  type AgentRuns = typeof import('~server/agent-runs');
  return {
    getSessionWorkspaceAffinity: vi.fn<
      AgentRuns['getSessionWorkspaceAffinity']
    >(async () => ({ state: 'uninitialized', runnerId: null })),
    assignRunToRunner: vi.fn<AgentRuns['assignRunToRunner']>(async () => {}),
    finalizeRunWorkspaceAffinity: vi.fn<
      AgentRuns['finalizeRunWorkspaceAffinity']
    >(async (_runId, _runnerId, expectedSessionId) =>
      Promise.resolve(expectedSessionId ?? 'session-from-run'),
    ),
    reconcileRunnerRuns: vi.fn<AgentRuns['reconcileRunnerRuns']>(async () => ({
      resumed: [],
      stale: [],
      pendingAnswers: [],
    })),
    renewRunnerLeases: vi.fn<AgentRuns['renewRunnerLeases']>(async () => {}),
    ingestRunnerEvent: vi.fn<AgentRuns['ingestRunnerEvent']>(async () => ({
      status: 'ok',
      sessionId: 'session-from-event',
    })),
    completeRunFromRunner: vi.fn<AgentRuns['completeRunFromRunner']>(
      async () => null,
    ),
  };
});

vi.mock('~server/agent-workspaces', () => {
  type Workspaces = typeof import('~server/agent-workspaces');
  return {
    reconcileRunnerWorkspaces: vi.fn<Workspaces['reconcileRunnerWorkspaces']>(
      async (_runnerId, sessionIds) => ({
        ownedSessionIds: sessionIds,
        staleSessionIds: [],
      }),
    ),
  };
});

const agentRuns = await import('~server/agent-runs');
const agentWorkspaces = await import('~server/agent-workspaces');
const {
  broadcastSessionWorkspaceCleanup,
  connectedRunnerCount,
  handleRunnerSocket,
  listConnectedRunners,
  dispatchRun,
  sendRunEnvAndWait,
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
  vi.mocked(agentRuns.getSessionWorkspaceAffinity).mockResolvedValue({
    state: 'uninitialized',
    runnerId: null,
  });
  vi.mocked(agentRuns.finalizeRunWorkspaceAffinity).mockImplementation(
    async (_runId, _runnerId, expectedSessionId) =>
      Promise.resolve(expectedSessionId ?? 'session-from-run'),
  );
  vi.mocked(agentRuns.ingestRunnerEvent).mockResolvedValue({
    status: 'ok',
    sessionId: 'session-from-event',
  });
  vi.mocked(agentRuns.completeRunFromRunner).mockResolvedValue(null);
  vi.mocked(agentWorkspaces.reconcileRunnerWorkspaces).mockImplementation(
    async (_runnerId, sessionIds) => ({
      ownedSessionIds: sessionIds,
      staleSessionIds: [],
    }),
  );
  // Fake only Date so lastSeen deltas are deterministic; timers stay real
  // because the hub's async message handling relies on them (vi.waitFor).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-07T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const runPayload: RunStartPayload = {
  runId: 'run-dispatch',
  sessionId: 'session-dispatch',
  userText: 'hello',
  composerContent: [{ type: 'text', text: 'hello' }],
  images: [],
  attachments: [],
  priorMessages: [],
  model: {
    providerId: 'provider-1',
    providerName: 'Provider',
    apiType: 'openai-responses',
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    model: {
      id: 'model-1',
      name: 'Model',
      reasoning: false,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  },
};

describe('workspace-affine dispatch', () => {
  it('dispatches a later turn only to the session workspace owner', async () => {
    const owner = await connectRunner(
      'runner-owner',
      [],
      [runPayload.sessionId],
    );
    const other = await connectRunner('runner-other');
    vi.mocked(agentRuns.getSessionWorkspaceAffinity).mockResolvedValueOnce({
      state: 'claimed',
      runnerId: 'runner-owner',
    });

    const dispatched = dispatchRun(runPayload);
    await vi.waitFor(() =>
      expect(owner.sent.some((message) => message.type === 'run.start')).toBe(
        true,
      ),
    );
    expect(other.sent.some((message) => message.type === 'run.start')).toBe(
      false,
    );
    owner.emit(
      'message',
      JSON.stringify({ type: 'run.accepted', runId: runPayload.runId }),
    );

    await expect(dispatched).resolves.toBe('runner-owner');
    expect(agentRuns.assignRunToRunner).toHaveBeenCalledWith(
      runPayload.runId,
      runPayload.sessionId,
      'runner-owner',
    );
    expect(agentRuns.finalizeRunWorkspaceAffinity).toHaveBeenCalledWith(
      runPayload.runId,
      'runner-owner',
      runPayload.sessionId,
    );
  });

  it('fails instead of switching when the workspace owner is unavailable', async () => {
    const other = await connectRunner('runner-other');
    vi.mocked(agentRuns.getSessionWorkspaceAffinity).mockResolvedValueOnce({
      state: 'claimed',
      runnerId: 'runner-offline',
    });

    await expect(dispatchRun(runPayload)).rejects.toThrow(
      'owns this chat workspace is unavailable',
    );
    expect(other.sent.some((message) => message.type === 'run.start')).toBe(
      false,
    );
    expect(agentRuns.assignRunToRunner).not.toHaveBeenCalled();
  });

  it('fails closed when the owner connection did not report the workspace', async () => {
    const owner = await connectRunner('runner-owner');
    vi.mocked(agentRuns.getSessionWorkspaceAffinity).mockResolvedValueOnce({
      state: 'claimed',
      runnerId: 'runner-owner',
    });

    await expect(dispatchRun(runPayload)).rejects.toThrow(
      'did not report its local data',
    );
    expect(owner.sent.some((message) => message.type === 'run.start')).toBe(
      false,
    );
    expect(agentRuns.assignRunToRunner).not.toHaveBeenCalled();
  });

  it('accepts a dispatch only from the exact selected connection', async () => {
    const selected = await connectRunner('runner-a');
    const other = await connectRunner('runner-b');
    const dispatched = dispatchRun(runPayload);
    await vi.waitFor(() =>
      expect(
        selected.sent.some((message) => message.type === 'run.start'),
      ).toBe(true),
    );

    other.emit(
      'message',
      JSON.stringify({ type: 'run.accepted', runId: runPayload.runId }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(agentRuns.finalizeRunWorkspaceAffinity).not.toHaveBeenCalled();

    selected.emit(
      'message',
      JSON.stringify({ type: 'run.accepted', runId: runPayload.runId }),
    );
    await expect(dispatched).resolves.toBe('runner-a');
    expect(agentRuns.finalizeRunWorkspaceAffinity).toHaveBeenCalledOnce();
  });

  it('accepts a dispatch when a valid event arrives before its acceptance frame', async () => {
    const selected = await connectRunner('runner-a');
    const dispatched = dispatchRun(runPayload);
    await vi.waitFor(() =>
      expect(
        selected.sent.some((message) => message.type === 'run.start'),
      ).toBe(true),
    );

    selected.emit(
      'message',
      JSON.stringify({
        type: 'run.event',
        runId: runPayload.runId,
        runnerSeq: 1,
        event: { type: 'text', delta: 'started' },
      }),
    );

    await expect(dispatched).resolves.toBe('runner-a');
    expect(agentRuns.ingestRunnerEvent).toHaveBeenCalledWith('runner-a', {
      type: 'run.event',
      runId: runPayload.runId,
      runnerSeq: 1,
      event: { type: 'text', delta: 'started' },
    });
    expect(agentRuns.finalizeRunWorkspaceAffinity).toHaveBeenCalledOnce();
  });

  it('rejects an exact dispatch waiter when its connection is replaced', async () => {
    const selected = await connectRunner('runner-a');
    const dispatched = dispatchRun(runPayload);
    const outcome = dispatched.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        selected.sent.some((message) => message.type === 'run.start'),
      ).toBe(true),
    );

    await connectRunner('runner-a');

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('connection was replaced');
    expect(agentRuns.finalizeRunWorkspaceAffinity).not.toHaveBeenCalled();
  });

  it('rejects an exact dispatch waiter when its connection closes', async () => {
    const selected = await connectRunner('runner-a');
    const dispatched = dispatchRun(runPayload);
    const outcome = dispatched.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(
        selected.sent.some((message) => message.type === 'run.start'),
      ).toBe(true),
    );

    selected.emit('close');

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Runner disconnected');
    expect(agentRuns.finalizeRunWorkspaceAffinity).not.toHaveBeenCalled();
  });

  it('does not finalize affinity when the selected runner rejects or send fails', async () => {
    const rejectedSocket = await connectRunner('runner-reject');
    const rejectedDispatch = dispatchRun(runPayload);
    await vi.waitFor(() =>
      expect(
        rejectedSocket.sent.some((message) => message.type === 'run.start'),
      ).toBe(true),
    );
    rejectedSocket.emit(
      'message',
      JSON.stringify({
        type: 'run.rejected',
        runId: runPayload.runId,
        reason: 'busy',
      }),
    );
    await expect(rejectedDispatch).rejects.toThrow('busy');
    expect(agentRuns.finalizeRunWorkspaceAffinity).not.toHaveBeenCalled();

    delete (globalThis as { __hatchRunnerHub__?: unknown }).__hatchRunnerHub__;
    vi.clearAllMocks();
    vi.mocked(agentRuns.getSessionWorkspaceAffinity).mockResolvedValue({
      state: 'uninitialized',
      runnerId: null,
    });
    const failedSocket = await connectRunner('runner-send-fail');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    failedSocket.send = () => {
      throw new Error('send failed');
    };

    await expect(dispatchRun(runPayload)).rejects.toThrow(
      'connection is closed',
    );
    expect(agentRuns.finalizeRunWorkspaceAffinity).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('runner connection snapshot', () => {
  it('does not log rejected frame contents', async () => {
    const socket = new FakeSocket();
    handleRunnerSocket(socket.asWebSocket());
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const canary = 'plaintext-canary-never-log';

    socket.emit('message', `{"type":"run.event","value":"${canary}`);
    await vi.waitFor(() => expect(socket.closed?.code).toBe(1008));

    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(canary);
    expect(consoleError).toHaveBeenCalledWith('[runner-hub] invalid message.');
    consoleError.mockRestore();
  });

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
        event: { type: 'text', delta: 'hi' },
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
      ownedSessionIds: ['active-session'],
      staleSessionIds: ['deleted-session'],
    });

    const socket = await connectRunner(
      'runner-a',
      [],
      ['active-session', 'deleted-session'],
    );

    expect(agentWorkspaces.reconcileRunnerWorkspaces).toHaveBeenCalledWith(
      'runner-a',
      ['active-session', 'deleted-session'],
    );
    expect(socket.sent).toContainEqual({
      type: 'hub.hello_ack',
      resumedRunIds: [],
      staleRunIds: [],
      staleWorkspaceSessionIds: ['deleted-session'],
    });
  });

  it('receives cleanup broadcasts while registration is still pending', async () => {
    let finish:
      | ((value: {
          ownedSessionIds: string[];
          staleSessionIds: string[];
        }) => void)
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

    finish?.({
      ownedSessionIds: [],
      staleSessionIds: ['deleted-session'],
    });
    await vi.waitFor(() =>
      expect(
        socket.sent.some((message) => message.type === 'hub.hello_ack'),
      ).toBe(true),
    );
    socket.emit('message', JSON.stringify({ type: 'runner.ready' }));
    await vi.waitFor(() => expect(connectedRunnerCount()).toBe(1));
  });

  it('broadcasts session cleanup to every online runner', async () => {
    const first = await connectRunner('runner-a');
    const second = await connectRunner('runner-b');

    broadcastSessionWorkspaceCleanup('session-a');

    for (const socket of [first, second]) {
      expect(socket.sent).toEqual(
        expect.arrayContaining([
          {
            type: 'workspace.cleanup',
            scope: 'session',
            sessionId: 'session-a',
          },
        ]),
      );
    }
  });
});

describe('transient environment delivery', () => {
  it('correlates concurrent submissions with distinct delivery ids', async () => {
    const socket = await connectRunner('runner-a');
    const entries = [
      { key: 'SERVICE_TOKEN', value: 'canary-secret-value', secret: true },
    ];

    const first = sendRunEnvAndWait('runner-a', 'run-1', 'secret-1', entries);
    const second = sendRunEnvAndWait('runner-a', 'run-1', 'secret-1', entries);

    const deliveries = socket.sent.filter(
      (message) => message.type === 'run.env',
    );
    expect(deliveries).toEqual([
      expect.objectContaining({
        type: 'run.env',
        runId: 'run-1',
        requestId: 'secret-1',
        deliveryId: expect.any(String),
        entries,
      }),
      expect.objectContaining({
        type: 'run.env',
        runId: 'run-1',
        requestId: 'secret-1',
        deliveryId: expect.any(String),
        entries,
      }),
    ]);
    const firstDeliveryId = deliveries[0].deliveryId;
    const secondDeliveryId = deliveries[1].deliveryId;
    expect(firstDeliveryId).not.toBe(secondDeliveryId);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    socket.emit(
      'message',
      JSON.stringify({
        type: 'run.env_result',
        runId: 'run-1',
        requestId: 'secret-1',
        deliveryId: firstDeliveryId,
        ok: true,
      }),
    );
    await expect(first).resolves.toEqual({ ok: true });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'run.env_result',
        runId: 'run-1',
        requestId: 'secret-1',
        deliveryId: secondDeliveryId,
        ok: false,
        errorCode: 'delivery_busy',
      }),
    );
    await expect(second).resolves.toEqual({
      ok: false,
      errorCode: 'delivery_busy',
    });
  });

  it('returns safe runner errors without exposing submitted values', async () => {
    const socket = await connectRunner('runner-a');
    const result = sendRunEnvAndWait('runner-a', 'run-1', 'secret-1', [
      { key: 'SERVICE_TOKEN', value: 'canary-secret-value', secret: true },
    ]);
    const delivery = [...socket.sent]
      .reverse()
      .find((message) => message.type === 'run.env');
    socket.emit(
      'message',
      JSON.stringify({
        type: 'run.env_result',
        runId: 'run-1',
        requestId: 'secret-1',
        deliveryId: delivery?.deliveryId,
        ok: false,
        errorCode: 'write_failed',
      }),
    );
    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: 'write_failed',
    });
  });

  it('does not log a socket error that embeds the environment payload', async () => {
    const socket = await connectRunner('runner-a');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    socket.send = (data: string) => {
      throw new Error(`socket echoed ${data}`);
    };

    await expect(
      sendRunEnvAndWait('runner-a', 'run-1', 'secret-1', [
        { key: 'SERVICE_TOKEN', value: 'plaintext-canary', secret: true },
      ]),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'runner_unavailable',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      'plaintext-canary',
    );
    consoleError.mockRestore();
  });

  it('cleans up waiters on timeout, disconnect, and unavailable runners', async () => {
    const socket = await connectRunner('runner-a');
    await expect(
      sendRunEnvAndWait(
        'runner-a',
        'run-timeout',
        'secret-timeout',
        [{ key: 'TOKEN', value: 'value', secret: true }],
        5,
      ),
    ).resolves.toEqual({ ok: false, errorCode: 'runner_timeout' });

    const disconnected = sendRunEnvAndWait(
      'runner-a',
      'run-disconnect',
      'secret-disconnect',
      [{ key: 'TOKEN', value: 'value', secret: false }],
    );
    socket.emit('close');
    await expect(disconnected).resolves.toEqual({
      ok: false,
      errorCode: 'runner_unavailable',
    });
    await expect(
      sendRunEnvAndWait('missing-runner', 'run-missing', 'secret-missing', [
        { key: 'TOKEN', value: 'value', secret: true },
      ]),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'runner_unavailable',
    });
  });
});
