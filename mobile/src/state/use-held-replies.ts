import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import type { SessionDetail, StreamState } from '../core';
import { useSession } from './session';
import {
  heldReplies,
  nextCheckDelay,
  noHeldReplies,
  type HeldAction,
  type HeldReplies,
} from './settled-run';

/**
 * Keeps stopped runs' unsaved replies on screen and re-reads the conversation
 * a bounded number of times until each is saved. Once the budget is spent a
 * person can check again; nothing is dropped until history holds it or the
 * conversation changes.
 *
 * The held replies belong to the conversation, not to one screen showing it:
 * folding or unfolding moves the conversation between the Agent list's pane
 * and its own screen, and the replacement must show the same replies. They
 * live in memory with the instance's other queries and are cleared with them.
 */
export function useHeldReplies(
  sessionId: string,
  read: () => Promise<{ data?: SessionDetail; error: unknown }>,
) {
  const { origin } = useSession();
  const client = useQueryClient();
  const { data: held = noHeldReplies } = useQuery<HeldReplies>({
    queryKey: [origin, 'held-replies', sessionId],
    queryFn: skipToken,
    initialData: noHeldReplies,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const dispatch = useCallback(
    (action: HeldAction) =>
      client.setQueryData<HeldReplies>(
        [origin, 'held-replies', sessionId],
        (previous = noHeldReplies) => heldReplies(previous, action),
      ),
    [client, origin, sessionId],
  );
  const delay = nextCheckDelay(held);
  const round = held.entries
    .map((entry) => `${entry.runId}:${entry.checks}`)
    .join();
  useEffect(() => {
    if (delay === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void read().then(
        (result) => {
          // A failed refetch keeps stale data, which proves nothing.
          if (!cancelled)
            dispatch({
              type: 'checked',
              detail: result.error ? null : (result.data ?? null),
            });
        },
        () => {
          if (!cancelled) dispatch({ type: 'checked', detail: null });
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [delay, round, read, dispatch]);
  const end = useCallback(
    (
      sessionId: string,
      runId: string,
      detail: SessionDetail,
      state: StreamState,
    ) => dispatch({ type: 'ended', sessionId, runId, detail, state }),
    [dispatch],
  );
  const recheck = useCallback(() => dispatch({ type: 'recheck' }), [dispatch]);
  return { held, end, recheck };
}
