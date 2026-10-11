import { DeviceAuthError } from './device-api';

/** Failures shown inline on the code form; the person can fix and resubmit. */
export type EntryProblem = 'invalid' | 'rate-limited' | 'network' | 'server';

/** Failures that end the current review and need their own explanation. */
export type Problem =
  | 'expired'
  | 'closed'
  | 'elsewhere'
  | 'signed-out'
  | 'origin'
  | 'rate-limited'
  | 'unconfirmed';

const codeOf = (error: unknown) =>
  error instanceof DeviceAuthError ? error.code : 'unexpected_response';

export function classifyClaimError(
  error: unknown,
): { entry: EntryProblem } | { problem: Problem } {
  switch (codeOf(error)) {
    case 'expired_token':
      return { problem: 'expired' };
    case 'already_decided':
      return { problem: 'closed' };
    case 'claimed_by_another_account':
      return { problem: 'elsewhere' };
    case 'unauthorized':
      return { problem: 'signed-out' };
    case 'invalid_request':
      return { entry: 'invalid' };
    case 'rate_limited':
      return { entry: 'rate-limited' };
    case 'network_error':
      return { entry: 'network' };
    default:
      return { entry: 'server' };
  }
}

export function classifyDecisionError(error: unknown): Problem {
  switch (codeOf(error)) {
    case 'expired_token':
      return 'expired';
    // Already approved/denied, or no longer exists.
    case 'invalid_request':
      return 'closed';
    case 'access_denied':
      return 'elsewhere';
    // The claim belongs to the account, so signing in again can continue.
    case 'unauthorized':
      return 'signed-out';
    case 'invalid_origin':
      return 'origin';
    // Rejected before the decision was considered.
    case 'rate_limited':
      return 'rate-limited';
    // No answer, or an answer we cannot read: the decision may or may not
    // have been recorded, so never report an outcome.
    default:
      return 'unconfirmed';
  }
}
