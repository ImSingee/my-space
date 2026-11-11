import { useCallback, useRef, useState } from 'react';

/**
 * Drives a RefreshControl from the user's pull only. Background query
 * refetches never touch it, because `refreshing={true}` makes iOS start the
 * spinner programmatically and shift the list.
 *
 * UIRefreshControl must not begin or end while its scroll view is off-screen,
 * or iOS can leave the spinner gap behind until the next manual scroll. So the
 * native value changes only while the screen is focused: a pull that settles
 * after the user left stays frozen and is released when the screen returns.
 * Keep the RefreshControl mounted; adding or removing it remounts list content.
 */
export function usePullToRefresh(
  focused: boolean,
  refresh: () => Promise<unknown>,
) {
  const [pulling, setPulling] = useState(false);
  const [shown, setShown] = useState(false);
  const inFlight = useRef(false);
  // Adjusted while rendering, so the frozen value is never committed stale.
  if (focused && shown !== pulling) setShown(pulling);
  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPulling(true);
    // Query refetches resolve with errors; either outcome ends the pull.
    void Promise.resolve()
      .then(refresh)
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
        setPulling(false);
      });
  }, [refresh]);
  return { refreshing: shown, onRefresh };
}
