import { DeviceAuthError, type DeviceDecision } from './device-api';

/** Failures shown inline on the code form; the person can fix and resubmit. */
export type EntryProblem = 'invalid' | 'rate-limited' | 'network' | 'server';

/** Failures that end the current review and need their own explanation. */
export type Problem =
  | 'expired'
  | 'closed'
  | 'elsewhere'
  | 'signed-out'
  | 'session-ended'
  | 'disabled'
  | 'origin'
  | 'unapprovable'
  | 'rate-limited'
  | 'unconfirmed';

const codeOf = (error: unknown) =>
  error instanceof DeviceAuthError ? error.code : 'unexpected_response';

/** Problems shared by review and decision calls. */
function terminalProblem(code: string): Problem | null {
  switch (code) {
    case 'expired_token':
      return 'expired';
    case 'grant_already_decided':
      return 'closed';
    case 'grant_claimed_by_another_session':
      return 'elsewhere';
    case 'issuance_disabled':
      return 'disabled';
    case 'invalid_origin':
    case 'instance_origin_mismatch':
      return 'origin';
    default:
      return null;
  }
}

export function classifyClaimError(
  error: unknown,
): { entry: EntryProblem } | { problem: Problem } {
  const code = codeOf(error);
  const problem = terminalProblem(code);
  if (problem) return { problem };
  switch (code) {
    case 'cookie_required':
    case 'invalid_credential':
      return { problem: 'signed-out' };
    case 'invalid_grant':
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

export function classifyDecisionError(
  error: unknown,
  decision: DeviceDecision,
): Problem {
  const code = codeOf(error);
  const problem = terminalProblem(code);
  if (problem) return problem;
  switch (code) {
    // The claim is bound to the Cookie session that reviewed it, so a new
    // sign-in cannot finish this request.
    case 'cookie_required':
    case 'invalid_credential':
      return 'session-ended';
    case 'invalid_grant':
      return 'closed';
    case 'resource_not_found':
      return decision === 'approve' ? 'unapprovable' : 'unconfirmed';
    // The budget is checked before the decision transaction starts.
    case 'rate_limited':
      return 'rate-limited';
    // No answer, or an answer we cannot read: the decision may or may not
    // have been recorded, so never report an outcome.
    default:
      return 'unconfirmed';
  }
}
