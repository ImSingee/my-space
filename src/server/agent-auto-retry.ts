/**
 * Automatic retry policy for failed Agent runs.
 *
 * A failed or interrupted run replays its turn after an exponential backoff.
 * The attempt number is the session's consecutive failure streak, so the
 * limit spans turns: only a completed run resets it.
 */

/** Automatic retries after consecutive failures before the platform stops. */
export const AGENT_AUTO_RETRY_MAX_ATTEMPTS = 5;

const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 160_000;
/** Spread retries so many sessions failing together do not fire together. */
const JITTER_RATIO = 0.2;

/**
 * Longest wait between checks for due retries. Local failures wake the
 * scheduler at their exact time; this catches retries scheduled by another
 * platform instance.
 */
export const AGENT_AUTO_RETRY_IDLE_POLL_MS = 30_000;

/** Statuses whose turn is replayed automatically. */
export const AGENT_AUTO_RETRY_STATUSES = ['failed', 'interrupted'] as const;

export function agentAutoRetryDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = (random() * 2 - 1) * JITTER_RATIO;
  return Math.round(base * (1 + jitter));
}

/** Whether a run that ended with `failureStreak` gets an automatic retry. */
export function shouldAutoRetry(failureStreak: number): boolean {
  return failureStreak >= 1 && failureStreak <= AGENT_AUTO_RETRY_MAX_ATTEMPTS;
}
