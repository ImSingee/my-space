import { useEffect, useRef } from 'react';

/**
 * Re-reads when a screen comes back into focus, such as after a pushed screen
 * closes over it. The first focus is skipped because the screen's own query
 * just loaded, and a new `refresh` identity never triggers another read.
 */
export function useRefreshOnReturn(focused: boolean, refresh: () => unknown) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  const wasFocused = useRef(focused);
  useEffect(() => {
    if (focused && !wasFocused.current) void latest.current();
    wasFocused.current = focused;
  }, [focused]);
}
