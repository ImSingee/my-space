/**
 * Pure helpers for sidebar pins. Kept free of db/server imports so they stay
 * trivially unit-testable.
 */

/** Upper bound on a stored entry-hash fragment; longer input is truncated. */
export const MAX_ENTRY_HASH_LEN = 512;

/**
 * Normalize a user-supplied app entry point into the hash fragment we store:
 * trimmed, with any leading '#' removed (apps use hash routing, so a pin to
 * '/settings' deep-links via `/apps/<id>#/settings`). Control characters are
 * dropped and the result is length-capped. Returns null for empty input, which
 * means "open the app root".
 */
export function normalizeEntryHash(input: string): string | null {
  let s = input.trim();
  if (s.startsWith('#')) s = s.slice(1).trim();
  // Strip control chars without a regex (oxlint forbids control-char regexes).
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  out = out.slice(0, MAX_ENTRY_HASH_LEN);
  return out.length > 0 ? out : null;
}
