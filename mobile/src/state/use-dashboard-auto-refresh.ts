import { useEffect } from 'react';

/**
 * The native host owns dashboard scheduling. `enabled` means the canvas is on
 * screen, loaded and the app is in the foreground; losing any of them stops
 * the timer, and regaining them starts a fresh full interval.
 */
export function useDashboardAutoRefresh({
  enabled,
  dashboardId,
  seconds,
  refresh,
}: {
  enabled: boolean;
  dashboardId?: string;
  seconds: number;
  refresh: () => void;
}) {
  useEffect(() => {
    if (!enabled || !dashboardId || seconds <= 0) return;
    const timer = setInterval(refresh, seconds * 1000);
    return () => clearInterval(timer);
  }, [enabled, dashboardId, seconds, refresh]);
}
