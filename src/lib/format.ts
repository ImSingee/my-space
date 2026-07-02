/**
 * Shared display formatting helpers. Importing this module also registers the
 * dayjs relativeTime plugin, so callers never need their own `dayjs.extend`.
 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

type DateInput = string | number | Date | null | undefined;

/** "3 minutes ago"-style relative timestamp. */
export function formatRelative(date: DateInput): string {
  return dayjs(date).fromNow();
}

/** Exact timestamp for tooltips / detail views. */
export function formatExact(date: DateInput): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ss');
}

/** Compact duration: `340ms`, `4.2s`, `38s`, `2m 05s`-style. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Compact byte size: `812 B`, `3.4 KB`, `1.2 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
