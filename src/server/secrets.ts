import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two secrets. Both sides are hashed to a
 * fixed-length digest first so the comparison neither leaks length nor
 * short-circuits on the first differing byte — important for public endpoints
 * (webhooks) where a remote caller can probe timing by repeated guesses.
 */
export function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
