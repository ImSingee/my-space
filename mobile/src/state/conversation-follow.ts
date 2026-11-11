import type { QueryClient } from '@tanstack/react-query';

/** How often a followed conversation is read while the list is on screen. */
export const FOLLOW_MS = 5000;
/** A run asked for just now may not exist on the server yet. */
export const START_GRACE_MS = 20_000;
/** List re-reads after a run ends, for a transcript that is saved later. */
export const AFTER_END_MS = [0, 3000, 10_000];

/** A conversation this device asked to run, followed until the list is current. */
export type FollowedConversation = {
  sessionId: string;
  /** When the run was asked for, before any request completed. */
  since: number;
  /** A read showed the run working. */
  sawRun: boolean;
  endedAt: number | null;
  /** List re-reads already made since the run ended. */
  listReads: number;
};

export function followKey(origin: string | null) {
  return [origin, 'followed-conversations'] as const;
}

/** Remember a conversation as working before its run request is even sent. */
export function markConversationWorking(
  queryClient: QueryClient,
  origin: string,
  sessionId: string,
  now = Date.now(),
) {
  queryClient.setQueryData<FollowedConversation[]>(
    followKey(origin),
    (list = []) => [
      ...list.filter((entry) => entry.sessionId !== sessionId),
      { sessionId, since: now, sawRun: false, endedAt: null, listReads: 0 },
    ],
  );
}

/**
 * One read of a followed conversation. `working` is null when the read
 * failed, which proves nothing either way.
 */
export function observe(
  entry: FollowedConversation,
  working: boolean | null,
  now: number,
): FollowedConversation {
  if (working === null) return entry;
  // The same entry comes back when nothing changed, so callers can tell.
  if (working)
    return entry.sawRun && entry.endedAt === null
      ? entry
      : { ...entry, sawRun: true, endedAt: null, listReads: 0 };
  if (entry.endedAt !== null) return entry;
  if (!entry.sawRun && now - entry.since < START_GRACE_MS) return entry;
  return { ...entry, endedAt: now };
}

/** Whether the conversation is still read for its run. */
export function needsRead(entry: FollowedConversation) {
  return entry.endedAt === null;
}

/** Milliseconds until the next list re-read is due, or null if none is. */
export function nextListRead(entry: FollowedConversation, now: number) {
  if (entry.endedAt === null || entry.listReads >= AFTER_END_MS.length)
    return null;
  return Math.max(0, entry.endedAt + AFTER_END_MS[entry.listReads] - now);
}

/**
 * Record a list re-read made at `now`: every due entry counts it, and those
 * with no re-reads left are no longer followed.
 */
export function listRead(list: FollowedConversation[], now: number) {
  return list
    .map((entry) =>
      nextListRead(entry, now) === 0
        ? { ...entry, listReads: entry.listReads + 1 }
        : entry,
    )
    .filter(
      (entry) =>
        entry.endedAt === null || entry.listReads < AFTER_END_MS.length,
    );
}
