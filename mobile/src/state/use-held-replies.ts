import { useCallback, useEffect, useReducer } from 'react';
import type { SessionDetail, StreamState } from '../core';
import { heldReplies, nextCheckDelay, noHeldReplies } from './settled-run';

/**
 * Keeps stopped runs' unsaved replies on screen and re-reads the conversation
 * a bounded number of times until each is saved. Once the budget is spent a
 * person can check again; nothing is dropped until history holds it or the
 * conversation changes.
 */
export function useHeldReplies(
  read: () => Promise<{ data?: SessionDetail; error: unknown }>,
) {
  const [held, dispatch] = useReducer(heldReplies, noHeldReplies);
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
  }, [delay, round, read]);
  const end = useCallback(
    (
      sessionId: string,
      runId: string,
      detail: SessionDetail,
      state: StreamState,
    ) => dispatch({ type: 'ended', sessionId, runId, detail, state }),
    [],
  );
  const recheck = useCallback(() => dispatch({ type: 'recheck' }), []);
  return { held, end, recheck };
}
