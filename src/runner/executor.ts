/**
 * The Agent Runner's run manager: executes agent turns, buffers their event
 * stream for at-least-once delivery to the platform, bridges ask/answer, and
 * reports the final transcript until the platform acknowledges it.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { submitAnswer, waitForAnswer } from '~agent/ask-registry';
import type { AgentStreamEvent, AskAnswer, AskQuestion } from '~agent/events';
import { buildRunModels } from '~agent/remote-models';
import { runAgentTurn } from '~agent/runtime';
import type { PlatformClient } from '~agent/platform-client';
import type { RunnerMessage, RunStartPayload } from '~agent/protocol';
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
  queue: RunEventQueue;
  controller: AbortController;
  cancelled: boolean;
  /** Stale runs are aborted and dropped without reporting run.finished. */
  discarded: boolean;
  /** Set once the turn ended; cleared from `runs` when the platform acks. */
  finished?: FinishedPayload;
  done: Promise<void>;
};

export class RunnerExecutor {
  private runs = new Map<string, ActiveRun>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private opts: {
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
      const { models, picked } = buildRunModels(payload.model);
      run = {
        runId: payload.runId,
        queue: new RunEventQueue(),
        controller: new AbortController(),
        cancelled: false,
        discarded: false,
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

      run.done = runAgentTurn({
        priorMessages: payload.priorMessages as AgentMessage[],
        sessionId: payload.sessionId,
        userText: payload.userText,
        images: payload.images,
        models,
        picked,
        platform: this.opts.platform,
        signal: run.controller.signal,
        ask,
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

  private finish(run: ActiveRun, payload: FinishedPayload): void {
    if (run.discarded) {
      this.runs.delete(run.runId);
      return;
    }
    run.finished = payload;
    this.sendFinished(run);
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
