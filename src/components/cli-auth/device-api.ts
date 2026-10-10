import { z } from 'zod';
import { CLI_SCOPES, resourceRangeSchema } from '~auth/cli-policy';

/**
 * Browser side of the device authorization review. Every call is an explicit
 * user action: a same-origin JSON POST carrying only the user code, sent with
 * the real Cookie session. No response is cached, retried or persisted, and
 * the browser never sees the device code or the issued key.
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

const claimSchema = z.object({
  userCode: z.string().min(1),
  account: z.string().min(1),
  // Unknown scopes fail closed: the page must be able to explain everything
  // it asks the person to approve.
  scopes: z.array(z.enum(CLI_SCOPES)).min(1),
  resources: resourceRangeSchema,
  credentialType: z.literal('interactive_key'),
  expiresIn: z.number().int().positive(),
  grantExpiresAt: z.iso.datetime(),
});

export type DeviceRequest = z.infer<typeof claimSchema> & {
  /** Local `Date.now()` value at which the server considers the request expired. */
  deadline: number;
};

export type DeviceDecision = 'approve' | 'deny';
export type DeviceOutcome = 'approved' | 'denied';

/** A failed call. `status` is null when no HTTP response arrived. */
export class DeviceAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
  ) {
    super(code);
    this.name = 'DeviceAuthError';
  }
}

const errorSchema = z.object({ error: z.string().min(1).max(64) });

async function post(action: 'claim' | DeviceDecision, userCode: string) {
  let response: Response;
  try {
    response = await fetch(`/api/cli/v1/auth/device/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: userCode }),
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
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    throw new DeviceAuthError(
      parsed.success ? parsed.data.error : 'unexpected_response',
      response.status,
    );
  }
  return { body, response };
}

export async function claimDeviceRequest(
  userCode: string,
): Promise<DeviceRequest> {
  const { body, response } = await post('claim', userCode);
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success)
    throw new DeviceAuthError('unexpected_response', response.status);
  // Count down against the server's clock so a skewed local clock neither
  // hides a live request nor keeps an expired one looking approvable.
  const serverNow = Date.parse(response.headers.get('date') ?? '');
  const skew = Number.isNaN(serverNow) ? 0 : serverNow - Date.now();
  return {
    ...parsed.data,
    deadline: Date.parse(parsed.data.grantExpiresAt) - skew,
  };
}

export async function decideDeviceRequest(
  userCode: string,
  decision: DeviceDecision,
): Promise<DeviceOutcome> {
  const { body, response } = await post(decision, userCode);
  const expected = decision === 'approve' ? 'approved' : 'denied';
  const parsed = z.object({ status: z.literal(expected) }).safeParse(body);
  // Only a matching, server-confirmed status counts as an outcome.
  if (!parsed.success)
    throw new DeviceAuthError('unexpected_response', response.status);
  return parsed.data.status;
}
