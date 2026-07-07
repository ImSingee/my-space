/**
 * Server-only: Runner Hub — the platform side of the Agent Runner control
 * channel. Runners open an outbound WebSocket to the internal server and this
 * module tracks who is connected, dispatches new runs, forwards
 * cancel/answer commands, and feeds runner events into `~server/agent-runs`.
 *
 * The platform never connects out to a runner: everything here reacts to
 * runner-initiated connections and messages.
 */
import type { WebSocket } from 'ws';
import {
  DISPATCH_ACCEPT_TIMEOUT_MS,
  parseRunnerMessage,
  PROTOCOL_VERSION,
  type AskAnswerPayload,
  type HubMessage,
  type RunnerMessage,
  type RunStartPayload,
} from '~agent/protocol';

type RunnerConn = {
  runnerId: string;
  socket: WebSocket;
  protocolVersion: number;
  /** Runs dispatched to (or reclaimed by) this runner on this connection. */
  activeRunIds: Set<string>;
  /** Epoch ms when this connection registered (runner.hello accepted). */
  connectedAt: number;
  /** Epoch ms of the last valid message on this connection (ping, events…). */
  lastSeenAt: number;
};

type DispatchWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HubState = {
  runners: Map<string, RunnerConn>;
  /** Pending run.start dispatches awaiting run.accepted / run.rejected. */
  dispatchWaiters: Map<string, DispatchWaiter>;
  /** Callers (e.g. cancel) waiting for a run's run.finished to be processed. */
  finishWaiters: Map<string, Set<() => void>>;
};

type HubGlobal = typeof globalThis & { __hatchRunnerHub__?: HubState };

function hubState(): HubState {
  const g = globalThis as HubGlobal;
  g.__hatchRunnerHub__ ??= {
    runners: new Map(),
    dispatchWaiters: new Map(),
    finishWaiters: new Map(),
  };
  return g.__hatchRunnerHub__;
}

function send(conn: RunnerConn, message: HubMessage): boolean {
  if (conn.socket.readyState !== conn.socket.OPEN) return false;
  try {
    conn.socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error(`[runner-hub] send to ${conn.runnerId} failed:`, error);
    return false;
  }
}

export function connectedRunnerCount(): number {
  return hubState().runners.size;
}

/** One connected runner as exposed to the status page (no socket internals). */
export type ConnectedRunnerInfo = {
  runnerId: string;
  protocolVersion: number;
  /** Runs currently carried by this connection. */
  activeRunCount: number;
  connectedAt: string;
  lastSeenAt: string;
};

/** Snapshot of every currently connected runner, stable-ordered by id. */
export function listConnectedRunners(): ConnectedRunnerInfo[] {
  return [...hubState().runners.values()]
    .map((conn) => ({
      runnerId: conn.runnerId,
      protocolVersion: conn.protocolVersion,
      activeRunCount: conn.activeRunIds.size,
      connectedAt: new Date(conn.connectedAt).toISOString(),
      lastSeenAt: new Date(conn.lastSeenAt).toISOString(),
    }))
    .sort((a, b) => a.runnerId.localeCompare(b.runnerId));
}

function ownerConn(runnerId: string | null | undefined): RunnerConn | null {
  if (!runnerId) return null;
  return hubState().runners.get(runnerId) ?? null;
}

/** Pick the connected runner with the fewest active runs. */
function pickRunner(): RunnerConn | null {
  let best: RunnerConn | null = null;
  for (const conn of hubState().runners.values()) {
    if (!best || conn.activeRunIds.size < best.activeRunIds.size) {
      best = conn;
    }
  }
  return best;
}

/**
 * Dispatch a run to a connected runner: assign the lease, send `run.start`,
 * and wait for the runner to accept. Throws when no runner is available, the
 * runner rejects, or the accept times out — the caller fails the run.
 */
export async function dispatchRun(payload: RunStartPayload): Promise<string> {
  const conn = pickRunner();
  if (!conn) {
    throw new Error('No Agent Runner is connected to the platform.');
  }

  const { assignRunToRunner } = await import('~server/agent-runs');
  await assignRunToRunner(payload.runId, conn.runnerId);
  conn.activeRunIds.add(payload.runId);

  const state = hubState();
  const accepted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.dispatchWaiters.delete(payload.runId);
      reject(new Error('Runner did not accept the run in time.'));
    }, DISPATCH_ACCEPT_TIMEOUT_MS);
    state.dispatchWaiters.set(payload.runId, { resolve, reject, timer });
  });

  if (!send(conn, { type: 'run.start', ...payload })) {
    settleDispatch(payload.runId, new Error('Runner connection is closed.'));
  }

  try {
    await accepted;
  } catch (error) {
    conn.activeRunIds.delete(payload.runId);
    throw error;
  }
  return conn.runnerId;
}

function settleDispatch(runId: string, error?: Error): void {
  const state = hubState();
  const waiter = state.dispatchWaiters.get(runId);
  if (!waiter) return;
  state.dispatchWaiters.delete(runId);
  clearTimeout(waiter.timer);
  if (error) waiter.reject(error);
  else waiter.resolve();
}

/** Forward a cancel to the runner executing the run (no-op when offline). */
export function sendRunCancel(
  runnerId: string | null | undefined,
  runId: string,
): boolean {
  const conn = ownerConn(runnerId);
  if (!conn) return false;
  return send(conn, { type: 'run.cancel', runId });
}

/** Forward the user's answers to the runner (no-op when offline). */
export function sendRunAnswer(
  runnerId: string | null | undefined,
  runId: string,
  askId: string,
  answers: AskAnswerPayload[],
): boolean {
  const conn = ownerConn(runnerId);
  if (!conn) return false;
  return send(conn, { type: 'run.answer', runId, askId, answers });
}

/**
 * Wait (bounded) until the runner's `run.finished` for this run has been
 * processed — used by cancel so the client's immediate refetch sees the
 * partial reply the runner persisted. Resolves early when nothing arrives.
 */
export function waitForRunFinished(
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const state = hubState();
  return new Promise((resolve) => {
    const waiters = state.finishWaiters.get(runId) ?? new Set();
    state.finishWaiters.set(runId, waiters);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      if (waiters.size === 0) state.finishWaiters.delete(runId);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    waiters.add(done);
  });
}

function notifyRunFinished(runId: string): void {
  const waiters = hubState().finishWaiters.get(runId);
  if (!waiters) return;
  // Each waiter removes itself from the set; deleting the current element
  // during Set iteration is well-defined.
  for (const done of waiters) done();
}

/**
 * Handle one runner WebSocket for its whole lifetime. The first message must
 * be `runner.hello`; afterwards events/finishes are fed into agent-runs and
 * commands flow back over the same socket.
 */
export function handleRunnerSocket(socket: WebSocket): void {
  let conn: RunnerConn | null = null;

  const close = (code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  };

  socket.on('message', (data) => {
    void (async () => {
      let message: RunnerMessage;
      try {
        message = parseRunnerMessage(
          JSON.parse(typeof data === 'string' ? data : data.toString('utf8')),
        );
      } catch (error) {
        console.error('[runner-hub] invalid message:', error);
        close(1008, 'Invalid message.');
        return;
      }

      if (!conn) {
        if (message.type !== 'runner.hello') {
          close(1008, 'Expected runner.hello first.');
          return;
        }
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          close(
            1008,
            `Unsupported protocol version ${message.protocolVersion}.`,
          );
          return;
        }
        conn = await registerRunner(socket, message);
        return;
      }

      conn.lastSeenAt = Date.now();
      try {
        await handleMessage(conn, message);
      } catch (error) {
        // Keep the connection: a transient DB failure must not kick the
        // runner (it would abort perfectly healthy runs on reconnect churn).
        console.error(
          `[runner-hub] failed to handle ${message.type} from ${conn.runnerId}:`,
          error,
        );
      }
    })();
  });

  socket.on('close', () => {
    const state = hubState();
    // `conn` is assigned only after registerRunner resolves; if this close
    // races that window, fall back to whatever registration stored for this
    // socket so a just-registered-but-dead runner can't linger as a ghost
    // that dispatches keep selecting.
    let registered = conn;
    if (!registered) {
      for (const candidate of state.runners.values()) {
        if (candidate.socket === socket) {
          registered = candidate;
          break;
        }
      }
    }
    if (!registered) return;
    // Only forget the runner when THIS socket is still its registered one —
    // a replacement connection (runner restart) must not be unregistered by
    // the old socket's close event.
    const current = state.runners.get(registered.runnerId);
    if (current && current.socket === socket) {
      state.runners.delete(registered.runnerId);
      for (const runId of registered.activeRunIds) {
        settleDispatch(runId, new Error('Runner disconnected.'));
      }
      console.log(
        `[runner-hub] runner ${registered.runnerId} disconnected ` +
          `(${registered.activeRunIds.size} active run(s) awaiting reconnect)`,
      );
    }
  });

  socket.on('error', (error) => {
    console.error('[runner-hub] socket error:', error);
  });
}

async function registerRunner(
  socket: WebSocket,
  hello: Extract<RunnerMessage, { type: 'runner.hello' }>,
): Promise<RunnerConn | null> {
  const state = hubState();
  const existing = state.runners.get(hello.runnerId);
  if (existing) {
    // Same runner id reconnected (restart or network flap): the new socket
    // wins, the old one is dead weight.
    existing.socket.terminate();
    state.runners.delete(hello.runnerId);
  }

  const now = Date.now();
  const conn: RunnerConn = {
    runnerId: hello.runnerId,
    socket,
    protocolVersion: hello.protocolVersion,
    activeRunIds: new Set(),
    connectedAt: now,
    lastSeenAt: now,
  };

  const { reconcileRunnerRuns } = await import('~server/agent-runs');
  const { resumed, stale, pendingAnswers } = await reconcileRunnerRuns(
    hello.runnerId,
    hello.activeRunIds,
  );
  for (const runId of resumed) conn.activeRunIds.add(runId);

  // The socket may have died while reconciliation was in flight; its close
  // event already ran (with no registration to clean up), so storing it now
  // would leave a permanent ghost runner that dispatches select and fail on.
  if (socket.readyState !== socket.OPEN) {
    console.warn(
      `[runner-hub] runner ${hello.runnerId} disconnected during registration`,
    );
    return null;
  }

  state.runners.set(hello.runnerId, conn);
  send(conn, {
    type: 'hub.hello_ack',
    resumedRunIds: resumed,
    staleRunIds: stale,
  });
  // Answers that arrived while the runner was offline: deliver now that the
  // runner reclaimed the runs.
  for (const pending of pendingAnswers) {
    send(conn, {
      type: 'run.answer',
      runId: pending.runId,
      askId: pending.askId,
      answers: pending.answers,
    });
  }
  console.log(
    `[runner-hub] runner ${hello.runnerId} connected ` +
      `(resumed ${resumed.length}, stale ${stale.length})`,
  );
  return conn;
}

async function handleMessage(
  conn: RunnerConn,
  message: RunnerMessage,
): Promise<void> {
  switch (message.type) {
    case 'runner.hello': {
      // A second hello on a live connection is a protocol violation; ignore.
      return;
    }
    case 'runner.ping': {
      const { renewRunnerLeases } = await import('~server/agent-runs');
      await renewRunnerLeases(conn.runnerId);
      send(conn, { type: 'hub.pong' });
      return;
    }
    case 'run.accepted': {
      settleDispatch(message.runId);
      return;
    }
    case 'run.rejected': {
      settleDispatch(
        message.runId,
        new Error(`Runner rejected the run: ${message.reason}`),
      );
      return;
    }
    case 'run.event': {
      const { ingestRunnerEvent } = await import('~server/agent-runs');
      const result = await ingestRunnerEvent(conn.runnerId, message);
      if (result === 'stale') {
        // The run no longer belongs to this runner (finished, interrupted,
        // …). Tell it to abort so it stops burning tokens on dead work.
        conn.activeRunIds.delete(message.runId);
        send(conn, { type: 'run.cancel', runId: message.runId });
      }
      // Ack even when stale/duplicate so the runner drains its buffer.
      send(conn, {
        type: 'run.event_ack',
        runId: message.runId,
        runnerSeq: message.runnerSeq,
      });
      return;
    }
    case 'run.finished': {
      const { completeRunFromRunner } = await import('~server/agent-runs');
      await completeRunFromRunner(conn.runnerId, message);
      conn.activeRunIds.delete(message.runId);
      send(conn, { type: 'run.finish_ack', runId: message.runId });
      notifyRunFinished(message.runId);
      return;
    }
  }
}
