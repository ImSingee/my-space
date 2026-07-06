/**
 * Per-run outbound event buffer. Every stream event gets a monotonically
 * increasing `runnerSeq`; events stay buffered until the platform acks them
 * (cumulative), so after a reconnect the whole unacked tail can be resent.
 * The platform dedupes on (runId, runnerSeq), making resends idempotent.
 */
import type { AgentStreamEvent } from '~agent/events';

export type QueuedRunEvent = {
  runnerSeq: number;
  event: AgentStreamEvent;
};

export class RunEventQueue {
  private nextSeq = 1;
  private pending: QueuedRunEvent[] = [];

  /** Assign the next runnerSeq and buffer the event until acked. */
  push(event: AgentStreamEvent): QueuedRunEvent {
    const queued = { runnerSeq: this.nextSeq++, event };
    this.pending.push(queued);
    return queued;
  }

  /** Cumulative ack: drop everything up to and including `runnerSeq`. */
  ack(runnerSeq: number): void {
    this.pending = this.pending.filter((e) => e.runnerSeq > runnerSeq);
  }

  /** Snapshot of unacked events, oldest first (for resend on reconnect). */
  unacked(): QueuedRunEvent[] {
    return [...this.pending];
  }

  get size(): number {
    return this.pending.length;
  }
}
