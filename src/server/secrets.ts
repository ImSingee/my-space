import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

/** Header names for the platform→app HMAC handshake (shared by cron/webhook/KV). */
export const HATCH_TIMESTAMP_HEADER = 'x-hatch-timestamp';
export const HATCH_SIGNATURE_HEADER = 'x-hatch-signature';

/**
 * Compute the platform's request signature: hex HMAC-SHA256 over
 * `<timestamp>.<payload>` keyed by the per-app signing secret. Binding the
 * timestamp lets the verifier reject replays; `payload` is whatever the caller
 * can reconstruct on both ends (the cron job name for RPC calls, the raw body
 * for webhooks). The result is prefixed `sha256=` so the scheme is greppable and
 * future-proof if the digest ever changes.
 */
export function hatchSignature(
  secret: string,
  timestamp: string,
  payload: string,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * Verify a platform signature in constant time, rejecting stale/forged values.
 * `maxSkewMs` bounds how old the timestamp may be (replay protection); default 5
 * minutes. Returns false on any malformed input rather than throwing so callers
 * on hot paths stay branch-simple.
 */
export function verifyHatchSignature(args: {
  secret: string | null | undefined;
  timestamp: string | null | undefined;
  payload: string;
  signature: string | null | undefined;
  maxSkewMs?: number;
}): boolean {
  const { secret, timestamp, payload, signature } = args;
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const maxSkewMs = args.maxSkewMs ?? 5 * 60 * 1000;
  if (Math.abs(Date.now() - ts) > maxSkewMs) return false;
  const expected = hatchSignature(secret, timestamp, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
