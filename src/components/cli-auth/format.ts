const UNITS = [
  { seconds: 86400, name: 'day' },
  { seconds: 3600, name: 'hour' },
  { seconds: 60, name: 'minute' },
] as const;

/** `604800` → `7 days`, `90000` → `1 day 1 hour`. At most two units. */
export function formatDuration(totalSeconds: number): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(totalSeconds));
  for (const unit of UNITS) {
    const count = Math.floor(rest / unit.seconds);
    if (count > 0 && parts.length < 2) {
      parts.push(`${count} ${unit.name}${count === 1 ? '' : 's'}`);
      rest -= count * unit.seconds;
    } else if (parts.length) break;
  }
  return parts.join(' ') || 'less than a minute';
}

/** Remaining milliseconds as `m:ss`. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatClockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
