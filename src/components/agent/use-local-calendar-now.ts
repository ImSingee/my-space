import { useInterval } from '@mantine/hooks';
import { useEffect, useState } from 'react';

const MIDNIGHT_BUFFER_MS = 50;
const CALENDAR_REFRESH_INTERVAL_MS = 60_000;

/** Keep local-calendar labels current across midnight and timezone changes. */
export function useLocalCalendarNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useInterval(() => setNow(new Date()), CALENDAR_REFRESH_INTERVAL_MS, {
    autoInvoke: true,
  });

  useEffect(() => {
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const timer = window.setTimeout(
      () => setNow(new Date()),
      Math.max(0, nextMidnight.getTime() - now.getTime()) + MIDNIGHT_BUFFER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [now]);

  return now;
}
