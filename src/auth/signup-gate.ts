/**
 * The sign-up gate enforced by the Better Auth `user.create.before` hook.
 *
 * Kept as its own module (separate from the `auth` instance) so tests can
 * exercise the gate against the config store without constructing Better
 * Auth. Imports stay relative — this is loaded from `src/auth/server.ts`,
 * which the Better Auth CLI reads and it cannot resolve the `~` alias.
 */
import { APIError } from 'better-auth/api';
import { getPlatformConfig } from '../server/platform-config';

/**
 * Reject user creation when self-service sign-up is closed. Reads the
 * platform config on every attempt, so toggling the setting applies
 * immediately — no server restart, unlike Better Auth's static
 * `disableSignUp` option which is fixed when the instance is constructed.
 */
export async function assertSignupAllowed(): Promise<void> {
  if (await getPlatformConfig('auth.allowSignup')) return;
  throw new APIError('BAD_REQUEST', {
    message: 'Sign-up is currently disabled.',
  });
}
