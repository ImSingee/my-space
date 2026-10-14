import { useCallback, useEffect, useRef } from 'react';

/** Mutation work is not cancelled by React Query when a screen is removed. */
export function useLifetimeSignal() {
  const current = useRef(new AbortController());
  useEffect(() => {
    // A new controller also handles React's development effect replay.
    const controller = new AbortController();
    current.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(() => current.current.signal, []);
}
