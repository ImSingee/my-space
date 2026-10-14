import { z } from 'zod';

/**
 * Browser side of CLI and mobile device login, on Better Auth's device endpoints.
 * Every call is an explicit user action made with the real Cookie session;
 * nothing is cached, retried or persisted, and the browser never sees the
 * device code or the session token the device receives.
 */

/** Better Auth's default user code: 8 characters, no 0/O/1/I. */
export const USER_CODE_LENGTH = 8;

/** Canonical form the server stores: uppercase, no separators. */
export function normalizeUserCode(raw: string): string {
  return raw
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, USER_CODE_LENGTH);
}

/** `ABCDEFGH` → `ABCD-EFGH`, matching what the device prints. */
export function formatUserCode(code: string): string {
  const half = USER_CODE_LENGTH / 2;
  return code.length > half
    ? `${code.slice(0, half)}-${code.slice(half)}`
    : code;
}

/** A pending request this account has claimed and may decide. */
export type DeviceRequest = {
  userCode: string;
  clientId: 'hatch-cli' | 'hatch-mobile';
};
export type DeviceDecision = 'approve' | 'deny';
export type DeviceOutcome = 'approved' | 'denied';

/** A failed call. `status` is null when no HTTP response arrived. */
export class DeviceAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    /** Seconds until a rate-limited call may be retried, when the server said. */
    readonly retryAfter: number | null = null,
  ) {
    super(code);
    this.name = 'DeviceAuthError';
  }
}

// Device endpoints answer `{ error }`; Better Auth's own checks (such as the
// Origin check) answer `{ code }`.
const errorSchema = z.object({
  error: z.string().min(1).max(64).optional(),
  code: z.string().min(1).max(64).optional(),
});

async function call(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new DeviceAuthError('network_error', null);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Fall through: a body that is not JSON is an unexpected response.
  }
  if (response.status === 429) {
    // Better Auth's limit on reviews lasts as long as a grant (10 minutes),
    // so report its actual remaining wait rather than guessing.
    const seconds = Number(response.headers.get('x-retry-after'));
    throw new DeviceAuthError(
      'rate_limited',
      429,
      Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    );
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const code = parsed.success
      ? (parsed.data.error ?? parsed.data.code?.toLowerCase())
      : undefined;
    throw new DeviceAuthError(code ?? 'unexpected_response', response.status);
  }
  return { body, response };
}

const verifySchema = z.object({
  status: z.enum(['pending', 'approved', 'denied']),
  client_id: z.string().optional(),
});

/**
 * Reading the code claims a pending, unclaimed request for the signed-in
 * account; only that account gets its details back.
 */
export async function claimDeviceRequest(
  userCode: string,
): Promise<DeviceRequest> {
  const { body, response } = await call(
    `/device?${new URLSearchParams({ user_code: userCode })}`,
  );
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success)
    throw new DeviceAuthError('unexpected_response', response.status);
  if (parsed.data.status !== 'pending')
    throw new DeviceAuthError('already_decided', response.status);
  if (!parsed.data.client_id) {
    // No details: either another account holds the claim, or this browser's
    // session is gone and the request was read anonymously.
    const session = await call('/get-session');
    throw new DeviceAuthError(
      session.body ? 'claimed_by_another_account' : 'unauthorized',
      response.status,
    );
  }
  if (
    parsed.data.client_id !== 'hatch-cli' &&
    parsed.data.client_id !== 'hatch-mobile'
  )
    throw new DeviceAuthError('unexpected_response', response.status);
  return { userCode, clientId: parsed.data.client_id };
}

export async function decideDeviceRequest(
  userCode: string,
  decision: DeviceDecision,
): Promise<DeviceOutcome> {
  const { body, response } = await call(`/device/${decision}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode }),
  });
  // Only an explicit, server-confirmed success counts as an outcome.
  if (!z.object({ success: z.literal(true) }).safeParse(body).success)
    throw new DeviceAuthError('unexpected_response', response.status);
  return decision === 'approve' ? 'approved' : 'denied';
}
