import { AuthError } from './credentials';

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Per-minute budgets for device creation (anonymous) and Cookie management
 * calls (per account). The platform is one process, so memory is enough;
 * per-peer limits belong at the trusted edge, not on forwarded IP headers.
 */
export function authRateLimit(
  action: string,
  actor = 'anonymous',
  maximum = 60,
) {
  const now = Date.now();
  for (const [key, bucket] of buckets)
    if (bucket.resetAt <= now) buckets.delete(key);
  const key = `${action}:${actor}`;
  const bucket = buckets.get(key) ?? { count: 0, resetAt: now + WINDOW_MS };
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count > maximum) throw new AuthError('rate_limited', 429);
}
