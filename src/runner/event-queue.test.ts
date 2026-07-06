import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '~agent/events';
import { RunEventQueue } from './event-queue';

const text = (delta: string): AgentStreamEvent => ({ type: 'text', delta });

describe('RunEventQueue', () => {
  it('assigns monotonically increasing runnerSeq starting at 1', () => {
    const queue = new RunEventQueue();
    expect(queue.push(text('a')).runnerSeq).toBe(1);
    expect(queue.push(text('b')).runnerSeq).toBe(2);
    expect(queue.push(text('c')).runnerSeq).toBe(3);
    expect(queue.size).toBe(3);
  });

  it('cumulative ack drops everything up to and including the seq', () => {
    const queue = new RunEventQueue();
    queue.push(text('a'));
    queue.push(text('b'));
    queue.push(text('c'));

    queue.ack(2);
    expect(queue.unacked().map((e) => e.runnerSeq)).toEqual([3]);

    // Re-acking an older seq is a no-op.
    queue.ack(1);
    expect(queue.size).toBe(1);

    queue.ack(3);
    expect(queue.size).toBe(0);
  });

  it('keeps assigning fresh seqs after an ack (no reuse)', () => {
    const queue = new RunEventQueue();
    queue.push(text('a'));
    queue.ack(1);
    expect(queue.push(text('b')).runnerSeq).toBe(2);
  });

  it('unacked returns oldest-first snapshots for resend', () => {
    const queue = new RunEventQueue();
    queue.push(text('a'));
    queue.push(text('b'));
    const snapshot = queue.unacked();
    expect(snapshot.map((e) => e.runnerSeq)).toEqual([1, 2]);
    // Mutating the snapshot must not affect the queue.
    snapshot.pop();
    expect(queue.size).toBe(2);
  });
});
