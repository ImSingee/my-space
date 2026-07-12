/**
 * Agent Runner entry point.
 *
 * A standalone Node service that executes agent turns on behalf of the
 * platform. It opens ONE outbound WebSocket to the platform's internal
 * server (never the other way around), announces itself with `runner.hello`,
 * and then executes dispatched runs, streaming events back and calling the
 * internal REST API for app/workflow operations.
 *
 * Environment:
 *   HATCH_PLATFORM_URL  platform internal base URL (default http://127.0.0.1:3701)
 *   AGENT_RUNNER_TOKEN  shared bearer secret (required in production)
 *   HATCH_RUNNER_ID     stable runner identity (default runner-<hostname>)
 *   HATCH_DATA_DIR      runner-local data dir for worktrees (see ~agent/paths)
 */
import { WebSocket } from 'ws';
import {
  parseHubMessage,
  PROTOCOL_VERSION,
  RUNNER_HEARTBEAT_MS,
  RUNNER_OFFLINE_ABORT_MS,
  type HubMessage,
  type RunnerMessage,
} from '~agent/protocol';
import {
  acquireSourceWorkspaceBarrier,
  type SourceWorkspaceBarrier,
} from '~agent/local-sources';
import { initializeAgentSandbox } from '~agent/shell-sandbox';
import { loadRunnerConfig } from './config';
import { RunnerExecutor } from './executor';
import { createPlatformRestClient } from './platform-rest';
import {
  inspectLocalWorkspaces,
  reconcileLocalWorkspaces,
  removeEntityWorkspaces,
  removeSessionWorkspace,
} from './workspace-cleanup';

const config = loadRunnerConfig();
// Before any run executes: on Linux, demote agent subprocesses to the
// unprivileged sandbox user so they cannot read this process's environment
// (AGENT_RUNNER_TOKEN) via /proc. Throws in production when unavailable.
initializeAgentSandbox();
const platform = createPlatformRestClient({
  baseUrl: config.platformUrl,
  token: config.token,
});

let ws: WebSocket | null = null;
let helloAcked = false;
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let offlineAbortTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let pendingResumedRunIds: string[] = [];
const registrationBarriers = new WeakMap<WebSocket, SourceWorkspaceBarrier>();

function releaseRegistrationBarrier(socket: WebSocket): void {
  const barrier = registrationBarriers.get(socket);
  if (!barrier) return;
  registrationBarriers.delete(socket);
  barrier.release();
}

function send(message: RunnerMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN || !helloAcked) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('[runner] send failed:', error);
    return false;
  }
}

const executor = new RunnerExecutor({ platform, send });

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
  console.log(`[runner] reconnecting in ${Math.round(delay / 1000)}s`);
}

function startOfflineAbortTimer(): void {
  if (offlineAbortTimer || executor.activeCount === 0) return;
  offlineAbortTimer = setTimeout(() => {
    offlineAbortTimer = undefined;
    // Past the lease window the platform has interrupted our runs; stop
    // burning tokens on work nobody can observe. Transcripts stay queued and
    // are reported if the connection ever comes back.
    console.warn(
      '[runner] offline past the lease window; aborting active runs',
    );
    executor.abortAll();
  }, RUNNER_OFFLINE_ABORT_MS);
}

function stopOfflineAbortTimer(): void {
  if (!offlineAbortTimer) return;
  clearTimeout(offlineAbortTimer);
  offlineAbortTimer = undefined;
}

function handleHubMessage(message: HubMessage): void {
  switch (message.type) {
    case 'hub.hello_ack': {
      const socket = ws;
      const barrier = socket ? registrationBarriers.get(socket) : undefined;
      if (!socket || !barrier) {
        socket?.close(1011, 'Missing workspace reconciliation barrier.');
        return;
      }
      pendingResumedRunIds = message.resumedRunIds;
      for (const runId of message.staleRunIds) {
        executor.abortStale(runId);
      }
      void (async () => {
        await Promise.all(
          message.staleWorkspaceSessionIds.map((sessionId) =>
            executor.abortSession(sessionId),
          ),
        );
        await reconcileLocalWorkspaces(
          {
            staleSessionIds: message.staleWorkspaceSessionIds,
            staleSources: message.staleWorkspaceSources,
          },
          barrier,
        );
        releaseRegistrationBarrier(socket);
        if (!socket || ws !== socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({ type: 'runner.ready' } satisfies RunnerMessage),
        );
      })().catch((error) => {
        releaseRegistrationBarrier(socket);
        console.error('[runner] workspace reconciliation failed:', error);
        if (socket && ws === socket) {
          socket.close(1011, 'Workspace reconciliation failed.');
        }
      });
      return;
    }
    case 'hub.ready_ack': {
      helloAcked = true;
      reconnectDelay = 1_000;
      stopOfflineAbortTimer();
      for (const runId of pendingResumedRunIds) {
        executor.resendPending(runId);
      }
      const resumed = pendingResumedRunIds.length;
      pendingResumedRunIds = [];
      console.log(
        `[runner] connected to ${config.platformUrl} (resumed ${resumed})`,
      );
      return;
    }
    case 'hub.pong': {
      return;
    }
    case 'run.start': {
      const { type: _type, ...payload } = message;
      const result = executor.start(payload);
      if (result.accepted) {
        send({ type: 'run.accepted', runId: message.runId });
        console.log(`[runner] run ${message.runId} started`);
      } else {
        send({
          type: 'run.rejected',
          runId: message.runId,
          reason: result.reason,
        });
        console.warn(
          `[runner] run ${message.runId} rejected: ${result.reason}`,
        );
      }
      return;
    }
    case 'run.cancel': {
      executor.cancel(message.runId);
      return;
    }
    case 'run.answer': {
      executor.answer(message.runId, message.askId, message.answers);
      return;
    }
    case 'run.event_ack': {
      executor.ackEvents(message.runId, message.runnerSeq);
      return;
    }
    case 'run.finish_ack': {
      executor.ackFinish(message.runId);
      console.log(`[runner] run ${message.runId} finished (acked)`);
      return;
    }
    case 'workspace.cleanup': {
      if (message.scope === 'session') {
        void executor
          .abortSession(message.sessionId)
          .then(() => removeSessionWorkspace(message.sessionId))
          .catch((error) => {
            console.error('[runner] session workspace cleanup failed:', error);
          });
      } else {
        void removeEntityWorkspaces(
          message.scope,
          message.id,
          message.generation,
        ).catch((error) => {
          console.error('[runner] entity workspace cleanup failed:', error);
        });
      }
      return;
    }
  }
}

function connect(): void {
  if (shuttingDown) return;
  helloAcked = false;
  const socket = new WebSocket(config.wsUrl, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  ws = socket;

  socket.on('open', () => {
    // hello bypasses send() (helloAcked is still false by design).
    void (async () => {
      const barrier = await acquireSourceWorkspaceBarrier();
      if (socket.readyState !== WebSocket.OPEN) {
        barrier.release();
        return;
      }
      registrationBarriers.set(socket, barrier);
      const workspace = await inspectLocalWorkspaces();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'runner.hello',
            runnerId: config.runnerId,
            protocolVersion: PROTOCOL_VERSION,
            activeRunIds: executor.activeRunIds(),
            workspaceSessionIds: workspace.sessionIds,
            workspaceSources: workspace.sources,
          } satisfies RunnerMessage),
        );
      }
    })().catch((error) => {
      releaseRegistrationBarrier(socket);
      console.error('[runner] could not inspect local workspaces:', error);
      socket.close(1011, 'Workspace inspection failed.');
    });
  });

  socket.on('message', (data) => {
    try {
      handleHubMessage(
        parseHubMessage(
          JSON.parse(typeof data === 'string' ? data : data.toString('utf8')),
        ),
      );
    } catch (error) {
      console.error('[runner] invalid hub message:', error);
    }
  });

  socket.on('close', (code, reason) => {
    releaseRegistrationBarrier(socket);
    if (ws !== socket) return;
    ws = null;
    helloAcked = false;
    pendingResumedRunIds = [];
    if (!shuttingDown) {
      console.warn(
        `[runner] connection closed (${code}${reason.length > 0 ? `: ${reason.toString()}` : ''})`,
      );
      startOfflineAbortTimer();
      scheduleReconnect();
    }
  });

  socket.on('error', (error) => {
    // 'close' follows and drives the reconnect.
    console.error('[runner] socket error:', error.message);
  });
}

setInterval(() => {
  send({ type: 'runner.ping' });
}, RUNNER_HEARTBEAT_MS).unref?.();

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runner] ${signal} received; aborting runs and closing`);
  executor.abortAll();
  // Give aborted turns a moment to flush run.finished (partial transcripts),
  // then close. The platform's lease sweeper covers anything we miss.
  setTimeout(() => {
    ws?.close();
    process.exit(0);
  }, 3_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  `[runner] ${config.runnerId} starting (platform: ${config.platformUrl})`,
);
connect();
