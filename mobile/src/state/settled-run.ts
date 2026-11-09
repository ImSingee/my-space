import type { JsonValue, SessionDetail, StreamState } from '../core';

/** Re-reads after a stop, while the reply is still unsaved (~30 s in all). */
export const SETTLE_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

type Transcript = Pick<SessionDetail, 'messages' | 'runs'>;

function role(message: JsonValue) {
  return message && typeof message === 'object' && !Array.isArray(message)
    ? message.role
    : undefined;
}

/** Whether the transcript holds a reply to the given (zero-based) user turn. */
export function replySaved(messages: JsonValue[], userTurn: number) {
  let turn = -1;
  for (const message of messages) {
    const kind = role(message);
    if (kind === 'user') {
      turn += 1;
      if (turn > userTurn) return false;
    } else if (kind === 'assistant' && turn === userTurn) return true;
  }
  return false;
}

/**
 * A stop or interruption can end a run before its partial reply is saved. A
 * completed run saves its reply before it ends, and a run that showed nothing
 * has nothing to lose.
 */
export function holdsUnsavedReply(
  detail: Transcript,
  runId: string,
  shown: Pick<StreamState, 'terminal' | 'blocks'>,
) {
  if (shown.terminal === 'done' || !shown.blocks.length) return false;
  const run = detail.runs.find((entry) => entry.id === runId);
  return !run || !replySaved(detail.messages, run.userTurn);
}

/** What a stopped run showed, frozen and kept with the user turn it answers. */
export type HeldReply = {
  runId: string;
  userTurn: number | null;
  state: StreamState;
  /** Background re-reads so far; past the budget only a person re-checks. */
  checks: number;
};

/** Held replies belong to one conversation and never follow you out of it. */
export type HeldReplies = { sessionId: string | null; entries: HeldReply[] };

export const noHeldReplies: HeldReplies = { sessionId: null, entries: [] };

export type HeldAction =
  /** The stream let go of a run, with its own final state. */
  | {
      type: 'ended';
      sessionId: string;
      runId: string;
      detail: Transcript;
      state: StreamState;
    }
  /** A background re-read finished; `detail` is null when it failed. */
  | { type: 'checked'; detail: Transcript | null }
  /** The person asked to look again: the re-read budget starts over. */
  | { type: 'recheck' };

function saved(entry: HeldReply, detail: Transcript) {
  return entry.userTurn !== null && replySaved(detail.messages, entry.userTurn);
}

export function heldReplies(
  current: HeldReplies,
  action: HeldAction,
): HeldReplies {
  switch (action.type) {
    case 'ended': {
      const entries =
        current.sessionId === action.sessionId ? current.entries : [];
      if (!holdsUnsavedReply(action.detail, action.runId, action.state))
        return { sessionId: action.sessionId, entries };
      const run = action.detail.runs.find((entry) => entry.id === action.runId);
      return {
        sessionId: action.sessionId,
        entries: [
          ...entries.filter((entry) => entry.runId !== action.runId),
          {
            runId: action.runId,
            userTurn: run?.userTurn ?? null,
            state: action.state,
            checks: 0,
          },
        ],
      };
    }
    case 'checked': {
      const { detail } = action;
      return {
        ...current,
        entries: current.entries.flatMap((entry) => {
          // A run missing from the snapshot it ended in gains its turn later.
          const userTurn =
            entry.userTurn ??
            detail?.runs.find((run) => run.id === entry.runId)?.userTurn ??
            null;
          const known = { ...entry, userTurn };
          if (detail && saved(known, detail)) return [];
          return [{ ...known, checks: entry.checks + 1 }];
        }),
      };
    }
    case 'recheck':
      return {
        ...current,
        entries: current.entries.map((entry) => ({ ...entry, checks: 0 })),
      };
  }
}

/** Delay before the next background re-read, or null once the budget is spent. */
export function nextCheckDelay(held: HeldReplies) {
  const due = held.entries
    .map((entry) => entry.checks)
    .filter((checks) => checks < SETTLE_DELAYS_MS.length);
  return due.length ? SETTLE_DELAYS_MS[Math.min(...due)] : null;
}

/** The held replies to show in this conversation's current transcript. */
export function shownHeldReplies(
  held: HeldReplies,
  sessionId: string,
  detail: Transcript | undefined,
) {
  if (held.sessionId !== sessionId) return [];
  return held.entries.filter((entry) => !detail || !saved(entry, detail));
}

/** Whether background re-reads for this held reply have run out. */
export function checksSpent(entry: HeldReply) {
  return entry.checks >= SETTLE_DELAYS_MS.length;
}

/**
 * Where each held reply is shown: right after the user message it answers,
 * so a newer turn never absorbs it. Replies without a known turn come last.
 */
export function placeHeldReplies(messages: JsonValue[], entries: HeldReply[]) {
  const after = new Map<number, HeldReply[]>();
  const rest: HeldReply[] = [];
  const userIndex: number[] = [];
  messages.forEach((message, index) => {
    if (role(message) === 'user') userIndex.push(index);
  });
  for (const entry of entries) {
    const index =
      entry.userTurn === null ? undefined : userIndex[entry.userTurn];
    if (index === undefined) rest.push(entry);
    else after.set(index, [...(after.get(index) ?? []), entry]);
  }
  return { after, rest };
}
