import { CLI_SCOPES } from '~auth/cli-policy';
import { db } from '~/db';
import { AuthError, issueCredential, readMetadata } from './credentials';

/**
 * Mint (or renew) a five-minute key for a live Run started by a real Cookie
 * user. Current users are single-tenant administrators, so the key carries
 * every lifecycle scope over all resources and nothing else. Each use rechecks
 * the Run's status, lease, Runner and session, so ending the Run ends the key.
 *
 * The shared internal token proves membership in the trusted fleet, not a
 * distinct Runner identity.
 */
export async function mintRunCredential(
  runId: string,
  runnerId: string,
  renewKeyId?: string,
) {
  const { listConnectedRunners } = await import('~server/agent-runner/hub');
  if (!listConnectedRunners().some((runner) => runner.runnerId === runnerId))
    throw new AuthError('runner_not_connected', 403);
  const run = await db.query.agentRuns.findFirst({ where: { id: runId } });
  if (
    !run?.startedByUserId ||
    run.runnerId !== runnerId ||
    !['running', 'blocked'].includes(run.status) ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= new Date()
  )
    throw new AuthError('run_authorization_ended', 401);
  if (renewKeyId) {
    // An expired previous key may still identify the Run it was minted for.
    const previous = await db.query.apikey.findFirst({
      where: { id: renewKeyId, referenceId: run.startedByUserId },
    });
    const previousRun = readMetadata(previous?.metadata ?? null)?.run;
    if (
      !previous?.enabled ||
      previousRun?.runId !== runId ||
      previousRun.sessionId !== run.sessionId ||
      previousRun.runnerId !== runnerId
    )
      throw new AuthError('renewal_conflict', 409);
  }
  const key = await issueCredential({
    userId: run.startedByUserId,
    credentialType: 'run_key',
    name: `Run ${runId}`,
    expiresIn: 300,
    scopes: [...CLI_SCOPES],
    resources: { mode: 'all' },
    run: { runId, sessionId: run.sessionId, runnerId },
  });
  // Renewal overlaps only until the previous key's own five-minute expiry.
  return { ...key, context: { runId, sessionId: run.sessionId, runnerId } };
}
