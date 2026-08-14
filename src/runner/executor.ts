/**
 * The Agent Runner's run manager: executes agent turns, buffers their event
 * stream for at-least-once delivery to the platform, bridges ask/answer, and
 * reports the final transcript until the platform acknowledges it.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { submitAnswer, waitForAnswer } from '~agent/ask-registry';
import type {
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
  EnvVariableField,
} from '~agent/events';
import { writeEnvFile } from '~agent/env-file';
import { agentWorkDir } from '~agent/paths';
import { buildRunModels } from '~agent/remote-models';
import { runAgentTurn } from '~agent/runtime';
import type { PlatformClient } from '~agent/platform-client';
import type { EnvEntry, RunnerMessage, RunStartPayload } from '~agent/protocol';
import { prepareAgentSessionSandbox } from '~agent/shell-sandbox';
import type { StoredEnvVariable } from '~agent/tools/request-env';
import { RunEventQueue } from './event-queue';

/** Resend an unacked `run.finished` this often while connected. */
const FINISH_RETRY_MS = 30_000;

type FinishedPayload = {
  status: 'completed' | 'failed' | 'cancelled';
  error?: string;
  messages: unknown[];
};

type ActiveRun = {
  runId: string;
  sessionId: string;
  queue: RunEventQueue;
  controller: AbortController;
  cancelled: boolean;
  /** Stale runs are aborted and dropped without reporting run.finished. */
  discarded: boolean;
  /** Set once the turn ended; cleared from `runs` when the platform acks. */
  finished?: FinishedPayload;
  emit: (event: AgentStreamEvent) => void;
  pendingEnv?: {
    requestId: string;
    keys: Set<string>;
    resolve: (variables: StoredEnvVariable[]) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
    inFlight?: { deliveryId: string; write: Promise<void> };
  };
  /** Safe, bounded delivery idempotency memory; never stores values. */
  completedEnvDeliveries: Map<string, string>;
  done: Promise<void>;
};

export class RunnerExecutor {
  private runs = new Map<string, ActiveRun>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private opts: {
      /** Public Hatch origin captured from the Runner's startup environment. */
      appUrl: string;
      /** Optional Tavily key; omission selects Tavily's keyless access mode. */
      tavilyApiKey?: string | null;
      platform: PlatformClient;
      /** Send a message to the platform; false when offline (kept buffered). */
      send: (message: RunnerMessage) => boolean;
    },
  ) {}

  /** Runs to reclaim in `runner.hello` (running or awaiting finish ack). */
  activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  get activeCount(): number {
    return this.runs.size;
  }

  /** Start executing a dispatched run. Idempotent for duplicate dispatches. */
  start(
    payload: RunStartPayload,
  ): { accepted: true } | { accepted: false; reason: string } {
    if (this.runs.has(payload.runId)) {
      return { accepted: true };
    }

    let run: ActiveRun;
    try {
      // `run.accepted` commits this Runner as the persistent workspace owner.
      // Prepare the session synchronously before returning accepted so a
      // rejected/unsafe filesystem layout can never pin an empty workspace.
      prepareAgentSessionSandbox(payload.sessionId);
      const { models, picked } = buildRunModels(payload.model);
      run = {
        runId: payload.runId,
        sessionId: payload.sessionId,
        queue: new RunEventQueue(),
        controller: new AbortController(),
        cancelled: false,
        discarded: false,
        emit: () => {},
        completedEnvDeliveries: new Map(),
        done: Promise.resolve(),
      };
      this.runs.set(payload.runId, run);

      const emit = (event: AgentStreamEvent) => {
        const queued = run.queue.push(event);
        this.opts.send({
          type: 'run.event',
          runId: run.runId,
          runnerSeq: queued.runnerSeq,
          event: queued.event,
        });
      };
      run.emit = emit;

      const ask = async (
        questions: AskQuestion[],
        askSignal?: AbortSignal,
      ): Promise<AskAnswer[]> => {
        if (run.cancelled) throw new Error('Agent run was cancelled.');
        const askId = crypto.randomUUID();
        emit({ type: 'ask', askId, questions });
        const answers = await waitForAnswer(
          run.runId,
          askId,
          askSignal ?? run.controller.signal,
        );
        if (run.cancelled) throw new Error('Agent run was cancelled.');
        emit({ type: 'ask_answered', askId });
        return answers;
      };

      const requestEnv = (
        reason: string,
        variables: EnvVariableField[],
        envSignal?: AbortSignal,
      ): Promise<StoredEnvVariable[]> => {
        if (run.cancelled) {
          return Promise.reject(new Error('Agent run was cancelled.'));
        }
        if (run.pendingEnv) {
          return Promise.reject(
            new Error('Another environment request is already pending.'),
          );
        }
        const requestId = crypto.randomUUID();
        const keys = new Set(variables.map((variable) => variable.key));
        return new Promise<StoredEnvVariable[]>((resolve, reject) => {
          let settled = false;
          const finish = (
            error?: Error,
            storedVariables?: StoredEnvVariable[],
          ) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (run.pendingEnv?.requestId === requestId) {
              run.pendingEnv = undefined;
            }
            if (error) reject(error);
            else resolve(storedVariables ?? []);
          };
          const onAbort = () =>
            finish(new Error('Environment request cancelled.'));
          const signals = [
            ...new Set([envSignal, run.controller.signal]),
          ].filter((value): value is AbortSignal => Boolean(value));
          const cleanup = () => {
            for (const signal of signals) {
              signal.removeEventListener('abort', onAbort);
            }
          };
          if (signals.some((signal) => signal.aborted)) {
            finish(new Error('Environment request cancelled.'));
            return;
          }
          for (const signal of signals) {
            signal.addEventListener('abort', onAbort, { once: true });
          }
          run.pendingEnv = {
            requestId,
            keys,
            resolve: (storedVariables) => finish(undefined, storedVariables),
            reject: (error) => finish(error),
            cleanup,
          };
          emit({ type: 'env_request', requestId, reason, variables });
        });
      };

      run.done = runAgentTurn({
        appUrl: this.opts.appUrl,
        ...(this.opts.tavilyApiKey
          ? { tavilyApiKey: this.opts.tavilyApiKey }
          : {}),
        priorMessages: payload.priorMessages as AgentMessage[],
        sessionId: payload.sessionId,
        userText: payload.userText,
        images: payload.images,
        attachments: payload.attachments,
        models,
        picked,
        platform: this.opts.platform,
        signal: run.controller.signal,
        ask,
        requestEnv,
        emit,
      })
        .then((result) => {
          this.finish(run, {
            status: run.cancelled
              ? 'cancelled'
              : result.error
                ? 'failed'
                : 'completed',
            ...(result.error && !run.cancelled ? { error: result.error } : {}),
            messages: result.messages,
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.finish(run, {
            status: run.cancelled ? 'cancelled' : 'failed',
            ...(run.cancelled ? {} : { error: message }),
            messages: [],
          });
        });
    } catch (error) {
      this.runs.delete(payload.runId);
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    this.ensureRetryTimer();
    return { accepted: true };
  }

  /** Abort a run; its partial transcript is still reported via run.finished. */
  cancel(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.finished) {
      // Terminal already; the platform (or a stale notice) raced our report.
      return;
    }
    run.cancelled = true;
    run.controller.abort();
  }

  /** Abort a run the platform disowned; never report it back. */
  abortStale(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.discarded = true;
    run.cancelled = true;
    if (run.finished) {
      this.runs.delete(runId);
      return;
    }
    run.controller.abort();
  }

  /** Deliver the user's answers to a waiting ask (idempotent). */
  answer(runId: string, askId: string, answers: AskAnswer[]): void {
    submitAnswer(runId, askId, answers);
  }

  /** Store a transient environment delivery for the exact pending request. */
  env(
    runId: string,
    requestId: string,
    deliveryId: string,
    entries: EnvEntry[],
  ): void {
    const run = this.runs.get(runId);
    const keys = entries.map((entry) => entry.key);
    const signature = JSON.stringify([
      requestId,
      entries
        .map(({ key, secret }) => ({ key, secret }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    ]);
    const completedSignature = run?.completedEnvDeliveries.get(deliveryId);
    if (run && completedSignature !== undefined) {
      this.sendEnvResult(
        runId,
        requestId,
        deliveryId,
        completedSignature === signature,
        completedSignature === signature ? undefined : 'request_mismatch',
      );
      return;
    }
    if (!run || run.cancelled || run.finished) {
      this.sendEnvResult(runId, requestId, deliveryId, false, 'run_not_active');
      return;
    }
    const pending = run.pendingEnv;
    const expectedKeys = pending?.keys ?? new Set<string>();
    if (
      !pending ||
      pending.requestId !== requestId ||
      new Set(keys).size !== keys.length ||
      expectedKeys.size !== keys.length ||
      keys.some((key) => !expectedKeys.has(key))
    ) {
      this.sendEnvResult(
        runId,
        requestId,
        deliveryId,
        false,
        'request_mismatch',
      );
      return;
    }
    // A delivery id identifies one HTTP submission. A duplicate frame for the
    // in-flight id waits for that exact result; a different submission fails
    // safely instead of inheriting the first write's acknowledgement.
    if (pending.inFlight) {
      if (pending.inFlight.deliveryId !== deliveryId) {
        this.sendEnvResult(
          runId,
          requestId,
          deliveryId,
          false,
          'delivery_busy',
        );
      }
      return;
    }

    const write = writeEnvFile(agentWorkDir(run.sessionId), entries)
      .then(() => {
        run.completedEnvDeliveries.set(deliveryId, signature);
        if (run.completedEnvDeliveries.size > 32) {
          const oldest = run.completedEnvDeliveries.keys().next().value;
          if (oldest) run.completedEnvDeliveries.delete(oldest);
        }
        if (run.pendingEnv === pending && !run.cancelled && !run.finished) {
          const storedVariables: StoredEnvVariable[] = entries.map((entry) =>
            entry.secret
              ? { key: entry.key, secret: true }
              : { key: entry.key, secret: false, value: entry.value },
          );
          run.emit({
            type: 'env_stored',
            requestId,
            variables: storedVariables.map(({ key, secret }) => ({
              key,
              secret,
            })),
          });
          pending.resolve(storedVariables);
        }
        // Once disk I/O starts, its exact outcome is reported even if cancel
        // has already stopped the model and cleared the pending tool request.
        this.sendEnvResult(runId, requestId, deliveryId, true);
      })
      .catch(() => {
        if (
          run.pendingEnv === pending &&
          pending.inFlight?.deliveryId === deliveryId
        ) {
          pending.inFlight = undefined;
        }
        this.sendEnvResult(runId, requestId, deliveryId, false, 'write_failed');
      });
    pending.inFlight = { deliveryId, write };
  }

  ackEvents(runId: string, upToRunnerSeq: number): void {
    this.runs.get(runId)?.queue.ack(upToRunnerSeq);
  }

  ackFinish(runId: string): void {
    const run = this.runs.get(runId);
    if (run?.finished) this.runs.delete(runId);
  }

  /** Resend the unacked tail + pending finish after a reconnect. */
  resendPending(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const queued of run.queue.unacked()) {
      this.opts.send({
        type: 'run.event',
        runId,
        runnerSeq: queued.runnerSeq,
        event: queued.event,
      });
    }
    if (run.finished) this.sendFinished(run);
  }

  /**
   * Abort every run (used when the platform has been unreachable past the
   * lease window — it has interrupted the runs already). Transcripts stay
   * queued; if the connection ever returns they are still reported so the
   * platform can persist the partial replies.
   */
  abortAll(): void {
    for (const run of this.runs.values()) {
      if (!run.finished) {
        run.cancelled = true;
        run.controller.abort();
      }
    }
  }

  /** Abort and settle every run using a session before its workspace is removed. */
  async abortSession(sessionId: string): Promise<void> {
    const affected = [...this.runs.values()].filter(
      (run) => run.sessionId === sessionId,
    );
    for (const run of affected) this.abortStale(run.runId);
    await Promise.all(affected.map((run) => run.done.catch(() => {})));
  }

  private finish(run: ActiveRun, payload: FinishedPayload): void {
    if (run.discarded) {
      this.runs.delete(run.runId);
      return;
    }
    run.finished = payload;
    this.sendFinished(run);
  }

  private sendEnvResult(
    runId: string,
    requestId: string,
    deliveryId: string,
    ok: boolean,
    errorCode?: string,
  ): void {
    this.opts.send({
      type: 'run.env_result',
      runId,
      requestId,
      deliveryId,
      ok,
      ...(ok ? {} : { errorCode: errorCode ?? 'write_failed' }),
    });
  }

  private sendFinished(run: ActiveRun): void {
    if (!run.finished) return;
    this.opts.send({
      type: 'run.finished',
      runId: run.runId,
      status: run.finished.status,
      ...(run.finished.error ? { error: run.finished.error } : {}),
      messages: run.finished.messages,
    });
  }

  /** Periodically retry unacked finish reports (lost ack, transient error). */
  private ensureRetryTimer(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      let any = false;
      for (const run of this.runs.values()) {
        if (run.finished) {
          this.sendFinished(run);
          any = true;
        }
      }
      if (!any && this.runs.size === 0 && this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = undefined;
      }
    }, FINISH_RETRY_MS);
    // Don't keep the process alive just for retries.
    this.retryTimer.unref?.();
  }
}
