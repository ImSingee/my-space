/**
 * Server-only: Runner Hub — the platform side of the Agent Runner control
 * channel. Runners open an outbound WebSocket to the internal server and this
 * module tracks who is connected, dispatches new runs, forwards
 * cancel/answer/environment commands, and feeds runner events into
 * `~server/agent-runs`.
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
  type EnvEntry,
} from '~agent/protocol';

type RunnerConn = {
  runnerId: string;
  socket: WebSocket;
  protocolVersion: number;
  /** Runs dispatched to (or reclaimed by) this runner on this connection. */
  activeRunIds: Set<string>;
  /** Session roots this exact connection proved were present on its volume. */
  workspaceSessionIds: Set<string>;
  /** False until the runner applies its reconnect cleanup snapshot. */
  ready: boolean;
  /** Epoch ms when this connection registered (runner.hello accepted). */
  connectedAt: number;
  /** Epoch ms of the last valid message on this connection (ping, events…). */
  lastSeenAt: number;
};

type DispatchWaiter = {
  conn: RunnerConn;
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RunEnvDeliveryResult =
  | { ok: true }
  | { ok: false; errorCode: string };

type EnvResultWaiter = {
  conn: RunnerConn;
  resolve: (result: RunEnvDeliveryResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HubState = {
  runners: Map<string, RunnerConn>;
  /** Pending run.start dispatches awaiting run.accepted / run.rejected. */
  dispatchWaiters: Map<string, DispatchWaiter>;
  /** Callers (e.g. cancel) waiting for a run's run.finished to be processed. */
  finishWaiters: Map<string, Set<() => void>>;
  /** Transient callers waiting for safe `run.env_result` acknowledgements. */
  envResultWaiters: Map<string, Set<EnvResultWaiter>>;
};

type HubGlobal = typeof globalThis & { __hatchRunnerHub__?: HubState };

function hubState(): HubState {
  const g = globalThis as HubGlobal;
  g.__hatchRunnerHub__ ??= {
    runners: new Map(),
    dispatchWaiters: new Map(),
    finishWaiters: new Map(),
    envResultWaiters: new Map(),
  };
  // A dev/HMR process may still hold a singleton created before env delivery.
  g.__hatchRunnerHub__.envResultWaiters ??= new Map();
  for (const conn of g.__hatchRunnerHub__.runners.values()) {
    conn.workspaceSessionIds ??= new Set();
  }
  return g.__hatchRunnerHub__;
}

function send(conn: RunnerConn, message: HubMessage): boolean {
  if (conn.socket.readyState !== conn.socket.OPEN) return false;
  try {
    conn.socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    if (message.type === 'run.env') {
      // Never pass an environment-delivery exception object to a logger: a socket
      // implementation could attach the attempted payload to the error.
      console.error(
        `[runner-hub] environment delivery to ${conn.runnerId} failed.`,
      );
      return false;
    }
    console.error(`[runner-hub] send to ${conn.runnerId} failed:`, error);
    return false;
  }
}

export function connectedRunnerCount(): number {
  return [...hubState().runners.values()].filter((conn) => conn.ready).length;
}

export function broadcastSessionWorkspaceCleanup(sessionId: string): void {
  for (const conn of hubState().runners.values()) {
    send(conn, { type: 'workspace.cleanup', scope: 'session', sessionId });
  }
}

export function broadcastEntityWorkspaceCleanup(
  scope: 'app' | 'workflow',
  id: string,
  generation: string,
): void {
  for (const conn of hubState().runners.values()) {
    send(conn, { type: 'workspace.cleanup', scope, id, generation });
  }
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
    .filter((conn) => conn.ready)
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
    if (!conn.ready) continue;
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
  const { assignRunToRunner, getSessionWorkspaceAffinity } =
    await import('~server/agent-runs');
  const affinity = await getSessionWorkspaceAffinity(payload.sessionId);
  const conn =
    affinity.state === 'claimed' ? ownerConn(affinity.runnerId) : pickRunner();
  if (!conn) {
    throw new Error(
      affinity.state === 'claimed'
        ? 'The Agent Runner that owns this chat workspace is unavailable.'
        : 'No Agent Runner is connected to the platform.',
    );
  }
  if (!conn.ready) {
    throw new Error(
      'The Agent Runner that owns this chat workspace is unavailable.',
    );
  }
  if (
    affinity.state === 'claimed' &&
    !conn.workspaceSessionIds.has(payload.sessionId)
  ) {
    throw new Error(
      'The Agent Runner that owns this chat workspace did not report its local data.',
    );
  }

  await assignRunToRunner(payload.runId, payload.sessionId, conn.runnerId);
  conn.activeRunIds.add(payload.runId);

  const state = hubState();
  const accepted = new Promise<void>((resolve, reject) => {
    const waiter = {} as DispatchWaiter;
    const timer = setTimeout(() => {
      if (state.dispatchWaiters.get(payload.runId) !== waiter) return;
      state.dispatchWaiters.delete(payload.runId);
      reject(new Error('Runner did not accept the run in time.'));
    }, DISPATCH_ACCEPT_TIMEOUT_MS);
    Object.assign(waiter, {
      conn,
      sessionId: payload.sessionId,
      resolve,
      reject,
      timer,
    });
    state.dispatchWaiters.set(payload.runId, waiter);
  });

  if (!send(conn, { type: 'run.start', ...payload })) {
    settleDispatch(
      payload.runId,
      conn,
      new Error('Runner connection is closed.'),
    );
  }

  try {
    await accepted;
  } catch (error) {
    conn.activeRunIds.delete(payload.runId);
    throw error;
  }
  return conn.runnerId;
}

function settleDispatch(runId: string, conn: RunnerConn, error?: Error): void {
  const state = hubState();
  const waiter = state.dispatchWaiters.get(runId);
  if (!waiter || waiter.conn !== conn) return;
  state.dispatchWaiters.delete(runId);
  clearTimeout(waiter.timer);
  if (error) waiter.reject(error);
  else waiter.resolve();
}

function settleDispatchWaitersForConnection(
  conn: RunnerConn,
  error: Error,
): void {
  for (const [runId, waiter] of hubState().dispatchWaiters) {
    if (waiter.conn === conn) settleDispatch(runId, conn, error);
  }
}

async function acceptDispatch(conn: RunnerConn, runId: string): Promise<void> {
  const state = hubState();
  const waiter = state.dispatchWaiters.get(runId);
  if (!waiter || waiter.conn !== conn) return;

  // Receipt of run.accepted met the wire deadline. Remove the waiter before
  // awaiting DB finalization so the timeout cannot reject and then leave a
  // newly committed affinity behind.
  state.dispatchWaiters.delete(runId);
  clearTimeout(waiter.timer);
  try {
    const { finalizeRunWorkspaceAffinity } = await import('~server/agent-runs');
    const sessionId = await finalizeRunWorkspaceAffinity(
      runId,
      conn.runnerId,
      waiter.sessionId,
    );
    conn.workspaceSessionIds.add(sessionId);
    waiter.resolve();
  } catch (error) {
    waiter.reject(
      error instanceof Error
        ? error
        : new Error('Could not finalize Runner workspace affinity.'),
    );
  }
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

export const RUN_ENV_RESULT_TIMEOUT_MS = 10_000;

function envWaiterKey(
  runId: string,
  requestId: string,
  deliveryId: string,
): string {
  return JSON.stringify([runId, requestId, deliveryId]);
}

function removeEnvResultWaiter(key: string, waiter: EnvResultWaiter): void {
  const waiters = hubState().envResultWaiters.get(key);
  if (!waiters) return;
  waiters.delete(waiter);
  if (waiters.size === 0) hubState().envResultWaiters.delete(key);
}

function settleEnvResultWaiters(
  runId: string,
  requestId: string,
  deliveryId: string,
  conn: RunnerConn,
  result: RunEnvDeliveryResult,
): void {
  const key = envWaiterKey(runId, requestId, deliveryId);
  const waiters = hubState().envResultWaiters.get(key);
  if (!waiters) return;
  for (const waiter of waiters) {
    if (waiter.conn !== conn) continue;
    clearTimeout(waiter.timer);
    removeEnvResultWaiter(key, waiter);
    waiter.resolve(result);
  }
}

function settleEnvResultWaitersForConnection(conn: RunnerConn): void {
  for (const [key, waiters] of hubState().envResultWaiters) {
    for (const waiter of waiters) {
      if (waiter.conn !== conn) continue;
      clearTimeout(waiter.timer);
      removeEnvResultWaiter(key, waiter);
      waiter.resolve({ ok: false, errorCode: 'runner_unavailable' });
    }
  }
}

/**
 * Forward environment values without persisting them and wait for the Runner's
 * value-free acknowledgement. Every HTTP submission gets a fresh, nonsecret
 * delivery id, so a result can settle only the caller whose frame was handled.
 */
export function sendRunEnvAndWait(
  runnerId: string | null | undefined,
  runId: string,
  requestId: string,
  entries: EnvEntry[],
  timeoutMs = RUN_ENV_RESULT_TIMEOUT_MS,
): Promise<RunEnvDeliveryResult> {
  const conn = ownerConn(runnerId);
  if (!conn?.ready) {
    return Promise.resolve({ ok: false, errorCode: 'runner_unavailable' });
  }

  const boundedTimeoutMs = Math.min(
    Math.max(0, timeoutMs),
    RUN_ENV_RESULT_TIMEOUT_MS,
  );
  const deliveryId = crypto.randomUUID();
  const key = envWaiterKey(runId, requestId, deliveryId);
  const result = new Promise<RunEnvDeliveryResult>((resolve) => {
    const waiters = hubState().envResultWaiters.get(key) ?? new Set();
    hubState().envResultWaiters.set(key, waiters);
    const waiter = {} as EnvResultWaiter;
    waiter.conn = conn;
    waiter.resolve = resolve;
    waiter.timer = setTimeout(() => {
      removeEnvResultWaiter(key, waiter);
      resolve({ ok: false, errorCode: 'runner_timeout' });
    }, boundedTimeoutMs);
    waiters.add(waiter);
  });

  if (
    !send(conn, {
      type: 'run.env',
      runId,
      requestId,
      deliveryId,
      entries,
    })
  ) {
    settleEnvResultWaiters(runId, requestId, deliveryId, conn, {
      ok: false,
      errorCode: 'runner_unavailable',
    });
  }
  return result;
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
      } catch {
        // Keep rejected frames out of logs. Although runner -> platform frames
        // must never carry environment values, a compromised peer can violate
        // that.
        console.error('[runner-hub] invalid message.');
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
        try {
          conn = await registerRunner(socket, message);
        } catch (error) {
          console.error('[runner-hub] runner registration failed:', error);
          close(1011, 'Runner registration failed.');
        }
        return;
      }

      // A replacement socket with the same stable runner id wins registration.
      // Ignore any buffered messages that arrive from the superseded connection.
      if (hubState().runners.get(conn.runnerId) !== conn) return;

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
    settleEnvResultWaitersForConnection(registered);
    settleDispatchWaitersForConnection(
      registered,
      new Error('Runner disconnected.'),
    );
    // Only forget the runner when THIS socket is still its registered one —
    // a replacement connection (runner restart) must not be unregistered by
    // the old socket's close event.
    const current = state.runners.get(registered.runnerId);
    if (current && current.socket === socket) {
      state.runners.delete(registered.runnerId);
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
    settleEnvResultWaitersForConnection(existing);
    settleDispatchWaitersForConnection(
      existing,
      new Error('Runner connection was replaced.'),
    );
    existing.socket.terminate();
    state.runners.delete(hello.runnerId);
  }

  const now = Date.now();
  const conn: RunnerConn = {
    runnerId: hello.runnerId,
    socket,
    protocolVersion: hello.protocolVersion,
    activeRunIds: new Set(),
    workspaceSessionIds: new Set(),
    ready: false,
    connectedAt: now,
    lastSeenAt: now,
  };

  // Register as pending before any reconciliation query. Cleanup broadcasts
  // that commit during this window must reach the socket, while pickRunner()
  // keeps it out of new-run dispatch until runner.ready arrives.
  state.runners.set(hello.runnerId, conn);

  let resumed: string[];
  let stale: string[];
  let pendingAnswers: {
    runId: string;
    askId: string;
    answers: AskAnswerPayload[];
  }[];
  let workspace: Awaited<
    ReturnType<
      typeof import('~server/agent-workspaces').reconcileRunnerWorkspaces
    >
  >;
  try {
    const { reconcileRunnerRuns } = await import('~server/agent-runs');
    ({ resumed, stale, pendingAnswers } = await reconcileRunnerRuns(
      hello.runnerId,
      hello.activeRunIds,
    ));
    for (const runId of resumed) conn.activeRunIds.add(runId);

    const { reconcileRunnerWorkspaces } =
      await import('~server/agent-workspaces');
    workspace = await reconcileRunnerWorkspaces(hello.runnerId, {
      sessionIds: hello.workspaceSessionIds,
      sources: hello.workspaceSources,
    });
    conn.workspaceSessionIds = new Set(workspace.ownedSessionIds);
  } catch (error) {
    if (state.runners.get(hello.runnerId) === conn) {
      state.runners.delete(hello.runnerId);
    }
    throw error;
  }

  // The socket may have died while reconciliation was in flight. Its close
  // handler normally removes this pending entry; keep this check as a backstop
  // when the close event has not run yet.
  if (socket.readyState !== socket.OPEN) {
    if (state.runners.get(hello.runnerId) === conn) {
      state.runners.delete(hello.runnerId);
    }
    console.warn(
      `[runner-hub] runner ${hello.runnerId} disconnected during registration`,
    );
    return null;
  }

  if (
    !send(conn, {
      type: 'hub.hello_ack',
      resumedRunIds: resumed,
      staleRunIds: stale,
      staleWorkspaceSessionIds: workspace.staleSessionIds,
      staleWorkspaceSources: workspace.staleSources,
    })
  ) {
    if (state.runners.get(hello.runnerId) === conn) {
      state.runners.delete(hello.runnerId);
    }
    return null;
  }
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
  console.log(`[runner-hub] runner ${hello.runnerId} awaiting workspace ready`);
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
    case 'runner.ready': {
      if (conn.ready) return;
      if (!send(conn, { type: 'hub.ready_ack' })) return;
      conn.ready = true;
      console.log(
        `[runner-hub] runner ${conn.runnerId} connected ` +
          `(${conn.activeRunIds.size} active run(s))`,
      );
      return;
    }
    case 'runner.ping': {
      const { renewRunnerLeases } = await import('~server/agent-runs');
      await renewRunnerLeases(conn.runnerId);
      send(conn, { type: 'hub.pong' });
      return;
    }
    case 'run.accepted': {
      await acceptDispatch(conn, message.runId);
      return;
    }
    case 'run.rejected': {
      settleDispatch(
        message.runId,
        conn,
        new Error(`Runner rejected the run: ${message.reason}`),
      );
      return;
    }
    case 'run.event': {
      const { ingestRunnerEvent } = await import('~server/agent-runs');
      const result = await ingestRunnerEvent(conn.runnerId, message);
      if (result.status === 'stale') {
        // The run no longer belongs to this runner (finished, interrupted,
        // …). Tell it to abort so it stops burning tokens on dead work.
        conn.activeRunIds.delete(message.runId);
        send(conn, { type: 'run.cancel', runId: message.runId });
      } else {
        conn.workspaceSessionIds.add(result.sessionId);
        // A valid event proves this exact connection accepted and opened the
        // assigned workspace even if its preceding run.accepted frame was
        // lost or is still waiting on an async handler.
        await acceptDispatch(conn, message.runId);
      }
      // Ack even when stale/duplicate so the runner drains its buffer.
      send(conn, {
        type: 'run.event_ack',
        runId: message.runId,
        runnerSeq: message.runnerSeq,
      });
      return;
    }
    case 'run.env_result': {
      settleEnvResultWaiters(
        message.runId,
        message.requestId,
        message.deliveryId,
        conn,
        message.ok
          ? { ok: true }
          : {
              ok: false,
              errorCode: message.errorCode ?? 'runner_error',
            },
      );
      return;
    }
    case 'run.finished': {
      const { completeRunFromRunner } = await import('~server/agent-runs');
      const sessionId = await completeRunFromRunner(conn.runnerId, message);
      if (sessionId) {
        conn.workspaceSessionIds.add(sessionId);
        // A final report is also definitive proof of acceptance. Completion
        // already finalized affinity before terminalizing the run.
        settleDispatch(message.runId, conn);
      }
      conn.activeRunIds.delete(message.runId);
      send(conn, { type: 'run.finish_ack', runId: message.runId });
      notifyRunFinished(message.runId);
      return;
    }
  }
}
