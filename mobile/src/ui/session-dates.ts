import type { SessionSummary } from '../core';

/** Local midnight `days` calendar days before `now`, whatever its length. */
function dayStart(now: Date, days: number) {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
  ).getTime();
}

/** Conversations grouped by local calendar day, newest group first. */
export function sectionsOf(sessions: SessionSummary[], now = new Date()) {
  const buckets = [
    { title: 'Today', from: dayStart(now, 0) },
    { title: 'Yesterday', from: dayStart(now, 1) },
    { title: 'This week', from: dayStart(now, 6) },
    { title: 'Earlier', from: -Infinity },
  ];
  return buckets
    .map((bucket, index) => ({
      title: bucket.title,
      data: sessions.filter((item) => {
        const at = new Date(item.updatedAt).getTime();
        const until = index ? buckets[index - 1].from : Infinity;
        return at >= bucket.from && at < until;
      }),
    }))
    .filter((section) => section.data.length);
}

/** Section headers already name the day; rows add the detail that is missing. */
export function stamp(iso: string, now = new Date()) {
  const at = new Date(iso);
  if (at.getTime() >= dayStart(now, 1))
    return at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  if (at.getTime() >= dayStart(now, 6))
    return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
