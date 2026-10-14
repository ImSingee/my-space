import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  initialStreamState,
  reduceStreamEvent,
  type HatchApiClient,
} from '../core';

/** A cursor belongs to its rendered state. Cold opens replay from zero. */
export function useRunStream(
  api: HatchApiClient | null,
  runId: string | null,
  reconcile: () => Promise<boolean>,
) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [state, setState] = useState(initialStreamState);
  const [connection, setConnection] = useState<
    'connecting' | 'live' | 'reconnecting' | 'paused'
  >('connecting');
  const stateRef = useRef(state);
  const owner = useRef<string | null>(null);
  const reconcileRef = useRef(reconcile);
  useEffect(() => {
    reconcileRef.current = reconcile;
  }, [reconcile]);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setActive(next === 'active'),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const key = api && runId ? `${api.origin}:${runId}` : null;
    if (owner.current !== key) {
      owner.current = key;
      stateRef.current = initialStreamState();
      setState(stateRef.current);
    }
    if (!api || !runId || !active || !focused) {
      setConnection('paused');
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    void (async () => {
      let backoff = 1000;
      while (!controller.signal.aborted) {
        setConnection(stateRef.current.lastSeq ? 'reconnecting' : 'connecting');
        try {
          if (!stateRef.current.terminal) {
            await api.streamRun(runId, {
              after: stateRef.current.lastSeq,
              signal: controller.signal,
              onEvent: (event) => {
                if (controller.signal.aborted) return;
                stateRef.current = reduceStreamEvent(stateRef.current, event);
                setState(stateRef.current);
                setConnection('live');
                backoff = 1000;
              },
            });
          }
          if (controller.signal.aborted) return;
          if (await reconcileRef.current()) return;
          // The SSE endpoint can report a transient transport error while the
          // run remains active. Re-read that sequence instead of losing an event.
          if (stateRef.current.terminal === 'error') {
            stateRef.current = {
              ...stateRef.current,
              terminal: null,
              error: null,
              lastSeq: Math.max(0, stateRef.current.lastSeq - 1),
            };
            setState(stateRef.current);
          }
        } catch {
          if (controller.signal.aborted) return;
          // Offline reconciliation is retried; the rendered state stays intact.
        }
        if (controller.signal.aborted) return;
        setConnection('reconnecting');
        await wait(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
      wake?.();
    };
  }, [api, runId, active, focused]);
  return { state, connection };
}
