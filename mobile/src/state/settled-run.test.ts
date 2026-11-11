import { describe, expect, it } from 'vitest';
import { initialStreamState, type JsonValue, type StreamState } from '../core';
import {
  SETTLE_DELAYS_MS,
  checksSpent,
  heldReplies,
  nextCheckDelay,
  noHeldReplies,
  placeHeldReplies,
  replySaved,
  shownHeldReplies,
  type HeldAction,
  type HeldReplies,
} from './settled-run';

const user = (text: string) => ({ role: 'user', content: text });
const assistant = (text: string) => ({ role: 'assistant', content: text });
const run = (id: string, userTurn: number) => ({
  id,
  status: 'cancelled' as const,
  userTurn,
  startedAt: '2026-11-09T00:00:00Z',
  completedAt: '2026-11-09T00:00:05Z',
  error: null,
});
const transcript = (messages: JsonValue[], runs: ReturnType<typeof run>[]) => ({
  messages,
  runs,
});
const partial = (
  text: string,
  terminal: StreamState['terminal'] = 'cancelled',
): StreamState => ({
  ...initialStreamState(),
  blocks: [{ kind: 'text', text }],
  terminal,
});
const replay = (...actions: HeldAction[]) =>
  actions.reduce<HeldReplies>(heldReplies, noHeldReplies);

describe('a stopped run keeps what it showed until its reply is saved', () => {
  it('finds the reply that belongs to a user turn, not a later one', () => {
    const messages = [user('a'), assistant('A'), user('b'), user('c')];
    expect(replySaved(messages, 0)).toBe(true);
    expect(replySaved(messages, 1)).toBe(false);
    expect(replySaved(messages, 2)).toBe(false);
  });

  it('keeps the frozen reply after the re-read budget runs out, until a person checks again', () => {
    const unsaved = transcript([user('a')], [run('r1', 0)]);
    let held = replay({
      type: 'ended',
      sessionId: 's1',
      runId: 'r1',
      detail: unsaved,
      state: partial('Half an answer'),
    });
    const delays: (number | null)[] = [];
    for (let read = 0; read < SETTLE_DELAYS_MS.length + 2; read++) {
      delays.push(nextCheckDelay(held));
      if (nextCheckDelay(held) !== null)
        held = heldReplies(held, { type: 'checked', detail: unsaved });
    }
    expect(delays).toEqual([...SETTLE_DELAYS_MS, null, null]);
    const [shown] = shownHeldReplies(held, 's1', unsaved);
    expect(shown.state.blocks).toEqual([
      { kind: 'text', text: 'Half an answer' },
    ]);
    expect(checksSpent(shown)).toBe(true);
    held = heldReplies(held, { type: 'recheck' });
    expect(nextCheckDelay(held)).toBe(SETTLE_DELAYS_MS[0]);
  });

  it('lets go once a late save lands, even after failed reads', () => {
    const unsaved = transcript([user('a')], [run('r1', 0)]);
    const held = replay(
      {
        type: 'ended',
        sessionId: 's1',
        runId: 'r1',
        detail: unsaved,
        state: partial('Half'),
      },
      { type: 'checked', detail: unsaved },
      { type: 'checked', detail: null },
      {
        type: 'checked',
        detail: transcript([user('a'), assistant('Half')], [run('r1', 0)]),
      },
    );
    expect(held.entries).toEqual([]);
    expect(nextCheckDelay(held)).toBeNull();
  });

  it('keeps an earlier unsaved reply on its own turn while a new run starts and ends', () => {
    const first = transcript([user('a')], [run('r1', 0)]);
    const next = transcript(
      [user('a'), user('b')],
      [run('r1', 0), run('r2', 1)],
    );
    let held = replay(
      {
        type: 'ended',
        sessionId: 's1',
        runId: 'r1',
        detail: first,
        state: partial('First'),
      },
      { type: 'checked', detail: next },
      {
        type: 'ended',
        sessionId: 's1',
        runId: 'r2',
        detail: next,
        state: partial('Second'),
      },
    );
    expect(
      shownHeldReplies(held, 's1', next).map((entry) => [
        entry.runId,
        entry.userTurn,
      ]),
    ).toEqual([
      ['r1', 0],
      ['r2', 1],
    ]);
    held = heldReplies(held, {
      type: 'checked',
      detail: transcript(
        [user('a'), assistant('First'), user('b')],
        [run('r1', 0), run('r2', 1)],
      ),
    });
    expect(held.entries.map((entry) => entry.runId)).toEqual(['r2']);
  });

  it('holds nothing for a completed or silent run and never outside its conversation', () => {
    const unsaved = transcript([user('a')], [run('r1', 0)]);
    expect(
      replay({
        type: 'ended',
        sessionId: 's1',
        runId: 'r1',
        detail: unsaved,
        state: partial('Done', 'done'),
      }).entries,
    ).toEqual([]);
    expect(
      replay({
        type: 'ended',
        sessionId: 's1',
        runId: 'r1',
        detail: unsaved,
        state: initialStreamState(),
      }).entries,
    ).toEqual([]);
    const held = replay({
      type: 'ended',
      sessionId: 's1',
      runId: 'r1',
      detail: unsaved,
      state: partial('Half'),
    });
    expect(shownHeldReplies(held, 's2', unsaved)).toEqual([]);
  });

  it('places a run that was missing from its snapshot once a re-read names its turn', () => {
    const missing = transcript([user('a')], []);
    let held = replay({
      type: 'ended',
      sessionId: 's1',
      runId: 'r1',
      detail: missing,
      state: partial('Half'),
    });
    expect(held.entries[0].userTurn).toBeNull();
    held = heldReplies(held, {
      type: 'checked',
      detail: transcript([user('a')], [run('r1', 0)]),
    });
    expect(held.entries[0].userTurn).toBe(0);
  });

  it('shows a held reply right after the user message it answers', () => {
    const messages = [user('a'), user('b'), assistant('B')];
    const held = replay(
      {
        type: 'ended',
        sessionId: 's1',
        runId: 'r1',
        detail: transcript(messages, [run('r1', 0)]),
        state: partial('First'),
      },
      {
        type: 'ended',
        sessionId: 's1',
        runId: 'rx',
        detail: transcript(messages, []),
        state: partial('Unknown'),
      },
    );
    const { after, rest } = placeHeldReplies(messages, held.entries);
    expect(after.get(0)?.map((entry) => entry.runId)).toEqual(['r1']);
    expect(after.has(1)).toBe(false);
    expect(rest.map((entry) => entry.runId)).toEqual(['rx']);
  });
});
