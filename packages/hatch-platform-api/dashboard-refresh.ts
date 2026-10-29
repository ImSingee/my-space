/**
 * Pure helpers for the dashboard auto-refresh control (Grafana-style).
 *
 * Kept free of React/DB imports so both the route UI and the server function can
 * share them and they stay trivially unit-testable.
 */

/** Auto-refresh interval presets in seconds; 0 disables it. */
export const REFRESH_PRESETS = [
  { label: 'Off', seconds: 0 },
  { label: '5s', seconds: 5 },
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
] as const;

/**
 * Largest interval the UI offers, and the upper bound we persist. Capping here
 * keeps `seconds * 1000` well under the browser's signed-32-bit setInterval
 * limit (~24.8 days), beyond which the delay overflows and fires near-instantly
 * — a direct (non-UI) caller could otherwise turn a huge value into a tight
 * refresh loop. Derived from the presets so it tracks any future additions.
 */
export const MAX_REFRESH_SECONDS = Math.max(
  ...REFRESH_PRESETS.map((p) => p.seconds),
);

/** Render a seconds interval as a compact label (e.g. 90 → "90s", 300 → "5m"). */
export function formatInterval(seconds: number): string {
  const preset = REFRESH_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Clamp arbitrary client input to a whole number of seconds in
 * [0, MAX_REFRESH_SECONDS] (0 = off). Never trust the client to send a sane
 * value: non-finite input becomes 0 and oversized input is capped so it can't
 * overflow the browser timer into a tight refresh loop.
 */
export function clampRefreshSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(MAX_REFRESH_SECONDS, Math.max(0, Math.trunc(seconds)));
}
