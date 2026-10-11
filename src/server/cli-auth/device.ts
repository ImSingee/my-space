import { eq } from 'drizzle-orm';
import { auth } from '~auth/server';
import {
  deviceRequestSchema,
  resourceRangeSchema,
  scopesSchema,
} from '~auth/cli-policy';
import { db, schema, type TX } from '~/db';
import { AuthError, issueCredential, validateResources } from './credentials';

const normalizeCode = (code: string) => code.replace(/-/g, '').toUpperCase();
type Device = typeof schema.deviceCode.$inferSelect;
type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function createDevice(raw: unknown) {
  const input = deviceRequestSchema.parse(raw);
  await validateResources(input.resources);
  return auth.api.deviceCode({
    body: {
      client_id: input.client_id,
      scope: input.scopes.join(' '),
      hatchResources: JSON.stringify(input.resources),
      hatchExpiresIn: input.expiresIn,
    },
  });
}

async function lockedCode(
  tx: TX,
  field: 'userCode' | 'deviceCode',
  code: string,
) {
  const [row] = await tx
    .select()
    .from(schema.deviceCode)
    .where(
      eq(
        schema.deviceCode[field],
        field === 'userCode' ? normalizeCode(code) : code,
      ),
    )
    .for('update');
  if (!row || row.clientId !== 'hatch-cli')
    throw new AuthError('invalid_grant', 400);
  return row;
}
function checkPending(row: Device) {
  if (row.expiresAt <= new Date()) throw new AuthError('expired_token', 400);
  if (row.status !== 'pending')
    throw new AuthError('grant_already_decided', 409);
}
function checkOwner(row: Device, session: Session) {
  if (
    row.userId !== session.user.id ||
    row.hatchSessionId !== session.session.id
  )
    throw new AuthError('grant_claimed_by_another_session', 403);
}
function grantOf(row: Device) {
  return {
    scopes: scopesSchema.parse((row.scope ?? '').split(' ')),
    resources: resourceRangeSchema.parse(JSON.parse(row.hatchResources)),
  };
}

/** Bind a pending grant to this exact user and Cookie session, then describe it. */
export async function claimDevice(userCode: string, session: Session) {
  return db.transaction(async (tx) => {
    const row = await lockedCode(tx, 'userCode', userCode);
    checkPending(row);
    if (row.userId || row.hatchSessionId) checkOwner(row, session);
    else
      await tx
        .update(schema.deviceCode)
        .set({ userId: session.user.id, hatchSessionId: session.session.id })
        .where(eq(schema.deviceCode.id, row.id));
    return {
      userCode: row.userCode,
      account: session.user.email,
      ...grantOf(row),
      credentialType: 'interactive_key' as const,
      expiresIn: row.hatchExpiresIn,
      grantExpiresAt: row.expiresAt,
    };
  });
}

export async function decideDevice(
  userCode: string,
  session: Session,
  approve: boolean,
) {
  await db.transaction(async (tx) => {
    const row = await lockedCode(tx, 'userCode', userCode);
    checkPending(row);
    checkOwner(row, session);
    if (approve) await validateResources(grantOf(row).resources, tx);
    await tx
      .update(schema.deviceCode)
      .set({ status: approve ? 'approved' : 'denied' })
      .where(eq(schema.deviceCode.id, row.id));
  });
  return { status: approve ? 'approved' : 'denied' };
}

export async function cancelDevice(deviceCode: string) {
  await db.transaction(async (tx) => {
    const row = await lockedCode(tx, 'deviceCode', deviceCode);
    if (row.status === 'cancelled') return;
    if (!['pending', 'approved'].includes(row.status))
      throw new AuthError('grant_already_decided', 409);
    await tx
      .update(schema.deviceCode)
      .set({ status: 'cancelled' })
      .where(eq(schema.deviceCode.id, row.id));
  });
  return { status: 'cancelled' };
}

/**
 * Use Better Auth's grant table and code generation, with a PostgreSQL row lock
 * around the complete transition. Its standalone approve/deny methods are not
 * conditional in 1.7.2; its session-token exchange is intentionally unavailable.
 * Poll errors are returned from the transaction so interval updates do commit.
 */
export async function redeemDevice(deviceCode: string) {
  const result = await db.transaction(async (tx) => {
    const row = await lockedCode(tx, 'deviceCode', deviceCode);
    if (row.status === 'consumed')
      return { error: 'invalid_grant', interval: 0 } as const;
    if (row.expiresAt <= new Date())
      return { error: 'expired_token', interval: 0 } as const;
    if (['denied', 'cancelled'].includes(row.status))
      return { error: 'access_denied', interval: 0 } as const;
    const intervalMs = row.pollingInterval ?? 5000;
    const interval = intervalMs / 1000;
    if (
      row.lastPolledAt &&
      Date.now() - row.lastPolledAt.getTime() < intervalMs
    ) {
      await tx
        .update(schema.deviceCode)
        .set({ lastPolledAt: new Date(), pollingInterval: intervalMs + 5000 })
        .where(eq(schema.deviceCode.id, row.id));
      return { error: 'slow_down', interval: interval + 5 } as const;
    }
    await tx
      .update(schema.deviceCode)
      .set({ lastPolledAt: new Date() })
      .where(eq(schema.deviceCode.id, row.id));
    if (row.status === 'pending')
      return { error: 'authorization_pending', interval } as const;
    if (row.status !== 'approved' || !row.userId || !row.hatchSessionId)
      return { error: 'invalid_grant', interval: 0 } as const;
    // The approving Cookie session must still exist: signing out, or a
    // password change that revokes sessions, withdraws an unredeemed approval.
    const approvingSession = await tx.query.session.findFirst({
      where: {
        id: row.hatchSessionId,
        userId: row.userId,
        expiresAt: { gt: new Date() },
      },
    });
    if (!approvingSession)
      return { error: 'invalid_grant', interval: 0 } as const;
    // Tombstone prevents repeated and concurrent exchanges, including failed issuance.
    await tx
      .update(schema.deviceCode)
      .set({ status: 'consumed' })
      .where(eq(schema.deviceCode.id, row.id));
    return { row } as const;
  });
  if ('error' in result) return result;
  return issueCredential({
    userId: result.row.userId!,
    credentialType: 'interactive_key',
    name: 'Browser-approved login',
    expiresIn: result.row.hatchExpiresIn,
    ...grantOf(result.row),
  });
}
