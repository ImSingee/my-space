import { eq } from 'drizzle-orm';
import { CLI_SCOPES, issuanceEnabled } from '~auth/cli-policy';
import { db, schema, type TX } from '~/db';
import {
  audit,
  AuthError,
  instance,
  issueCredential,
  userEpoch,
} from './credentials';

/** Called inside real Cookie-initiated run creation, never from Agent input. */
export async function recordRunAuthorization(
  tx: TX,
  runId: string,
  sessionId: string,
  userId: string,
) {
  if (!issuanceEnabled()) return;
  const inst = await instance(tx);
  const epoch = await userEpoch(tx, userId);
  // Current platform users are single-tenant administrators. This grant narrows
  // that authority to lifecycle operations; mentions do not create new authority.
  await tx.insert(schema.cliRunAuthorizations).values({
    runId,
    sessionId,
    userId,
    userEpoch: epoch,
    instanceId: inst.instanceId,
    instanceEpoch: inst.epoch,
    scopes: [...CLI_SCOPES],
    resources: { mode: 'all' },
  });
  await audit(tx, 'run.authorize', userId, null, runId, { sessionId });
}

export async function validateRunGrant(
  tx: TX,
  runId: string,
  runnerId: string,
  userId?: string,
  epoch?: number,
) {
  const [run] = await tx
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .for('share');
  const [grant] = await tx
    .select()
    .from(schema.cliRunAuthorizations)
    .where(eq(schema.cliRunAuthorizations.runId, runId))
    .for('share');
  const inst = await instance(tx);
  if (
    !run ||
    !grant ||
    grant.revokedAt ||
    (userId && grant.userId !== userId) ||
    (epoch && grant.epoch !== epoch) ||
    run.runnerId !== runnerId ||
    run.sessionId !== grant.sessionId ||
    !['running', 'blocked'].includes(run.status) ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= new Date() ||
    grant.instanceId !== inst.instanceId ||
    grant.instanceEpoch !== inst.epoch ||
    (await userEpoch(tx, grant.userId)) !== grant.userEpoch
  )
    throw new AuthError('run_authorization_ended', 401);
  return grant;
}

/** The shared internal token proves membership in the trusted fleet, not a distinct Runner identity. */
export async function mintRunCredential(
  runId: string,
  runnerId: string,
  renewKeyId?: string,
) {
  const { listConnectedRunners } = await import('~server/agent-runner/hub');
  if (!listConnectedRunners().some((runner) => runner.runnerId === runnerId))
    throw new AuthError('runner_not_connected', 403);
  const grant = await db.transaction((tx) =>
    validateRunGrant(tx, runId, runnerId),
  );
  if (renewKeyId) {
    const old = await db.query.cliCredentialBindings.findFirst({
      where: { keyId: renewKeyId, runId, runnerId, credentialType: 'run_key' },
    });
    if (!old || old.revokedAt || old.runEpoch !== grant.epoch)
      throw new AuthError('renewal_conflict', 409);
  }
  const key = await issueCredential({
    userId: grant.userId,
    userEpoch: grant.userEpoch,
    instanceId: grant.instanceId,
    instanceEpoch: grant.instanceEpoch,
    credentialType: 'run_key',
    name: `Run ${runId}`,
    expiresIn: 300,
    scopes: grant.scopes,
    resources: grant.resources,
    run: { runId, sessionId: grant.sessionId, runnerId, epoch: grant.epoch },
  });
  // Renewal overlaps only until the previous five-minute TTL. Host replaces its
  // delivered token. Expired keys may renew only while the original run grant is live.
  return { ...key, context: { runId, sessionId: grant.sessionId, runnerId } };
}
