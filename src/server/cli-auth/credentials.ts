/** Server-only opaque credentials. Plugin verification never grants a Cookie session. */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { auth } from '~auth/server';
import {
  issuanceEnabled,
  grantSchema,
  permissionsFor,
  resourceRangeSchema,
  scopesFrom,
  type CliScope,
  type CredentialType,
  type ResourceRange,
} from '~auth/cli-policy';
import { db, schema, type TX } from '~/db';
import { getPlatformEnv } from '~env';
import { AppError } from '~server/errors';

export class AuthError extends AppError {
  userId?: string;
  credentialId?: string;
  constructor(
    public code: string,
    status: number,
  ) {
    super(code, status);
  }
}
export function requireIssuance(): void {
  if (!issuanceEnabled()) throw new AuthError('issuance_disabled', 503);
}
export async function audit(
  tx: TX,
  action: string,
  userId: string | null,
  credentialId: string | null = null,
  runId: string | null = null,
  details: typeof schema.cliAuthAudit.$inferInsert.details = {},
) {
  await tx
    .insert(schema.cliAuthAudit)
    .values({ id: randomUUID(), action, userId, credentialId, runId, details });
}

export async function instance(tx: TX | typeof db = db) {
  await tx
    .insert(schema.cliAuthInstance)
    .values({ id: 'platform', instanceId: randomUUID() })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(schema.cliAuthInstance)
    .where(eq(schema.cliAuthInstance.id, 'platform'));
  return row;
}
export async function userEpoch(tx: TX | typeof db, userId: string) {
  // No guessed issuer and no cached authorization. A deleted user is never valid.
  const [user] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!user) throw new AuthError('invalid_credential', 401);
  await tx
    .insert(schema.cliUserSecurity)
    .values({ userId })
    .onConflictDoNothing();
  const [state] = await tx
    .select()
    .from(schema.cliUserSecurity)
    .where(eq(schema.cliUserSecurity.userId, userId));
  return state.epoch;
}

/** Cookie only, with no API-key/Bearer input forwarded to Better Auth. */
export async function cookieSession(request: Request, mutation = true) {
  if (request.headers.has('authorization') || request.headers.has('x-api-key'))
    throw new AuthError('cookie_required', 401);
  if (mutation) {
    const origin = request.headers.get('origin');
    if (
      origin !== getPlatformEnv().appUrl ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new AuthError('invalid_origin', 403);
  }
  const headers = new Headers();
  headers.set('cookie', request.headers.get('cookie') ?? '');
  const session = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session) throw new AuthError('cookie_required', 401);
  return session;
}

export async function validateResources(
  resources: ResourceRange,
  tx: TX | typeof db = db,
) {
  if (resources.mode === 'all') return;
  if (
    new Set(resources.apps).size !== resources.apps.length ||
    new Set(resources.workflows).size !== resources.workflows.length
  )
    throw new AuthError('duplicate_resource', 400);
  const apps = resources.apps.length
    ? await tx.query.apps.findMany({
        where: { id: { in: resources.apps } },
        columns: { id: true },
      })
    : [];
  const workflows = resources.workflows.length
    ? await tx.query.workflows.findMany({
        where: { id: { in: resources.workflows } },
        columns: { id: true },
      })
    : [];
  if (
    apps.length !== resources.apps.length ||
    workflows.length !== resources.workflows.length
  )
    throw new AuthError('resource_not_found', 404);
}

type Binding = typeof schema.cliCredentialBindings.$inferSelect;
export type CliPrincipal = {
  userId: string;
  credentialId: string;
  credentialType: CredentialType;
  scopes: CliScope[];
  resources: ResourceRange;
  instanceId: string;
  context: { sessionId: string; runId: string; runnerId: string } | null;
};

/** Re-check a saved binding at the write boundary, taking locks in the caller's transaction. */
async function checkBinding(
  binding: Binding,
  tx: TX | typeof db,
  lock = false,
) {
  const query = tx
    .select()
    .from(schema.cliCredentialBindings)
    .where(eq(schema.cliCredentialBindings.keyId, binding.keyId));
  const [current] = await (lock ? query.for('share') : query);
  const keyQuery = tx
    .select()
    .from(schema.apikey)
    .where(eq(schema.apikey.id, binding.keyId));
  const [key] = await (lock ? keyQuery.for('share') : keyQuery);
  if (
    !current ||
    current.revokedAt ||
    !key?.enabled ||
    !key.expiresAt ||
    key.expiresAt <= new Date() ||
    key.referenceId !== current.userId ||
    key.configId !== 'hatch'
  )
    throw new AuthError('invalid_credential', 401);
  const instanceQuery = tx
    .select()
    .from(schema.cliAuthInstance)
    .where(eq(schema.cliAuthInstance.id, 'platform'));
  const [inst] = await (lock ? instanceQuery.for('share') : instanceQuery);
  const userQuery = tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, current.userId));
  const [user] = await (lock ? userQuery.for('share') : userQuery);
  const epochQuery = tx
    .select()
    .from(schema.cliUserSecurity)
    .where(eq(schema.cliUserSecurity.userId, current.userId));
  const [security] = await (lock ? epochQuery.for('share') : epochQuery);
  if (
    !user ||
    !security ||
    security.epoch !== current.userEpoch ||
    !inst ||
    inst.instanceId !== current.instanceId ||
    inst.epoch !== current.instanceEpoch
  )
    throw new AuthError('invalid_credential', 401);
  if (current.credentialType === 'run_key') {
    const runQuery = tx
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, current.runId!));
    const [run] = await (lock ? runQuery.for('share') : runQuery);
    const grantQuery = tx
      .select()
      .from(schema.cliRunAuthorizations)
      .where(eq(schema.cliRunAuthorizations.runId, current.runId!));
    const [grant] = await (lock ? grantQuery.for('share') : grantQuery);
    if (
      !run ||
      !grant ||
      grant.revokedAt ||
      grant.epoch !== current.runEpoch ||
      grant.userId !== current.userId ||
      grant.sessionId !== current.sessionId ||
      run.sessionId !== current.sessionId ||
      run.runnerId !== current.runnerId ||
      !['running', 'blocked'].includes(run.status) ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= new Date()
    )
      throw new AuthError('run_authorization_ended', 401);
  }
  return {
    binding: current,
    key,
    scopes: scopesFrom(JSON.parse(key.permissions ?? '{}')),
  };
}

export async function resolveCredential(
  request: Request,
): Promise<CliPrincipal> {
  const authorization = request.headers.get('authorization');
  if (!authorization || request.headers.has('x-api-key'))
    throw new AuthError('credential_required', 401);
  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  if (!match || match[1].length > 512)
    throw new AuthError('invalid_credential', 401);
  const verified = await auth.api.verifyApiKey({
    body: { key: match[1], configId: 'hatch' },
  });
  if (verified.error?.code === 'RATE_LIMITED')
    throw new AuthError('rate_limited', 429);
  if (!verified.valid || !verified.key)
    throw new AuthError('invalid_credential', 401);
  const binding = await db.query.cliCredentialBindings.findFirst({
    where: { keyId: verified.key.id },
  });
  if (!binding) throw new AuthError('invalid_credential', 401);
  const checked = await checkBinding(binding, db);
  return {
    userId: binding.userId,
    credentialId: binding.keyId,
    credentialType: binding.credentialType,
    scopes: checked.scopes,
    resources: resourceRangeSchema.parse(binding.resources),
    instanceId: binding.instanceId,
    context:
      binding.credentialType === 'run_key'
        ? {
            sessionId: binding.sessionId!,
            runId: binding.runId!,
            runnerId: binding.runnerId!,
          }
        : null,
  };
}

export function requirePermission(
  principal: CliPrincipal,
  scope: CliScope,
  resourceId?: string,
) {
  const denied = (code: string) =>
    Object.assign(new AuthError(code, 403), {
      userId: principal.userId,
      credentialId: principal.credentialId,
    });
  if (!principal.scopes.includes(scope)) throw denied('insufficient_scope');
  const kind = scope.startsWith('app.') ? 'apps' : 'workflows';
  if (
    principal.resources.mode === 'ids' &&
    (scope.endsWith('.create') ||
      (resourceId != null && !principal.resources[kind].includes(resourceId)))
  )
    throw denied('resource_forbidden');
}
export async function authorizeCommit(
  principal: CliPrincipal,
  scope: CliScope,
  resourceId: string | undefined,
  tx: TX,
) {
  const binding = await tx.query.cliCredentialBindings.findFirst({
    where: { keyId: principal.credentialId },
  });
  if (!binding) throw new AuthError('invalid_credential', 401);
  const checked = await checkBinding(binding, tx, true);
  requirePermission(
    {
      ...principal,
      scopes: checked.scopes,
      resources: checked.binding.resources,
    },
    scope,
    resourceId,
  );
}

export type IssueInput = {
  userId: string;
  credentialType: CredentialType;
  name: string;
  expiresIn: number;
  scopes: CliScope[];
  resources: ResourceRange;
  userEpoch: number;
  instanceId: string;
  instanceEpoch: number;
  run?: { runId: string; sessionId: string; runnerId: string; epoch: number };
  rotateKeyId?: string;
};

/**
 * Better Auth's API uses its own connection. Create an unbound key, then activate
 * context + audit atomically. Without the binding, even a valid plugin key has no
 * Hatch access. Never pretend these two connections form one transaction.
 */
export async function issueCredential(input: IssueInput) {
  requireIssuance();
  grantSchema.parse({ scopes: input.scopes, resources: input.resources });
  const maximum =
    input.credentialType === 'interactive_key' ? 30 * 86400 : 90 * 86400;
  if (
    !Number.isInteger(input.expiresIn) ||
    input.expiresIn < 300 ||
    input.expiresIn > maximum ||
    (input.credentialType === 'run_key' &&
      (!input.run || input.expiresIn !== 300))
  )
    throw new AuthError('invalid_expiration', 400);
  const key = await auth.api.createApiKey({
    body: {
      configId: 'hatch',
      userId: input.userId,
      name: input.name,
      expiresIn: input.expiresIn,
      permissions: permissionsFor(input.scopes),
      rateLimitEnabled: true,
      rateLimitMax: 120,
      rateLimitTimeWindow: 60000,
    },
  });
  try {
    await db.transaction(async (tx) => {
      const inst = await instance(tx);
      await tx
        .select()
        .from(schema.cliAuthInstance)
        .where(eq(schema.cliAuthInstance.id, 'platform'))
        .for('share');
      const [lockedUser] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.id, input.userId))
        .for('share');
      if (!lockedUser) throw new AuthError('grant_invalidated', 401);
      if (
        inst.instanceId !== input.instanceId ||
        inst.epoch !== input.instanceEpoch ||
        (await userEpoch(tx, input.userId)) !== input.userEpoch
      )
        throw new AuthError('grant_invalidated', 401);
      // Lock epochs so password changes/deletion and rotation serialize with activation.
      await tx
        .select()
        .from(schema.cliUserSecurity)
        .where(eq(schema.cliUserSecurity.userId, input.userId))
        .for('share');
      if ((await userEpoch(tx, input.userId)) !== input.userEpoch)
        throw new AuthError('grant_invalidated', 401);
      await validateResources(input.resources, tx);
      if (input.run) {
        const { validateRunGrant } = await import('./runs');
        await validateRunGrant(
          tx,
          input.run.runId,
          input.run.runnerId,
          input.userId,
          input.run.epoch,
        );
      }
      if (input.rotateKeyId) {
        const [old] = await tx
          .select()
          .from(schema.cliCredentialBindings)
          .where(
            and(
              eq(schema.cliCredentialBindings.keyId, input.rotateKeyId),
              eq(schema.cliCredentialBindings.userId, input.userId),
            ),
          )
          .for('update');
        if (!old || old.revokedAt || old.credentialType === 'run_key')
          throw new AuthError('rotation_conflict', 409);
        const [oldKey] = await tx
          .select()
          .from(schema.apikey)
          .where(eq(schema.apikey.id, old.keyId))
          .for('update');
        if (
          !oldKey?.enabled ||
          !oldKey.expiresAt ||
          oldKey.expiresAt <= new Date() ||
          old.userEpoch !== input.userEpoch ||
          old.instanceEpoch !== input.instanceEpoch ||
          old.instanceId !== input.instanceId ||
          old.credentialType !== input.credentialType ||
          JSON.stringify(old.resources) !== JSON.stringify(input.resources) ||
          JSON.stringify(scopesFrom(JSON.parse(oldKey.permissions ?? '{}'))) !==
            JSON.stringify(input.scopes)
        )
          throw new AuthError('rotation_conflict', 409);
        await revoke(tx, old, 'rotated');
      }
      await tx.insert(schema.cliCredentialBindings).values({
        keyId: key.id,
        credentialType: input.credentialType,
        userId: input.userId,
        userEpoch: input.userEpoch,
        instanceId: input.instanceId,
        instanceEpoch: input.instanceEpoch,
        resources: input.resources,
        displayName: input.name,
        issuedExpiresAt: key.expiresAt!,
        runId: input.run?.runId,
        sessionId: input.run?.sessionId,
        runnerId: input.run?.runnerId,
        runEpoch: input.run?.epoch,
      });
      await audit(
        tx,
        input.rotateKeyId ? 'key.rotate' : 'key.issue',
        input.userId,
        key.id,
        input.run?.runId,
        {
          credentialType: input.credentialType,
          scopes: input.scopes,
          expiresIn: input.expiresIn,
          resourcesMode: input.resources.mode,
          apps: input.resources.mode === 'ids' ? input.resources.apps : [],
          workflows:
            input.resources.mode === 'ids' ? input.resources.workflows : [],
        },
      );
    });
  } catch (error) {
    // Best-effort cleanup is not the authorization boundary: the missing binding is.
    await db
      .update(schema.apikey)
      .set({ enabled: false })
      .where(eq(schema.apikey.id, key.id))
      .catch(() => {});
    throw error;
  }
  return {
    id: key.id,
    token: key.key,
    credentialType: input.credentialType,
    instanceId: input.instanceId,
    scopes: input.scopes,
    resources: input.resources,
    expiresAt: key.expiresAt,
  };
}

export async function revoke(tx: TX, binding: Binding, reason: string) {
  await tx
    .update(schema.cliCredentialBindings)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.cliCredentialBindings.keyId, binding.keyId),
        isNull(schema.cliCredentialBindings.revokedAt),
      ),
    );
  await tx
    .update(schema.apikey)
    .set({ enabled: false })
    .where(eq(schema.apikey.id, binding.keyId));
  await audit(tx, 'key.revoke', binding.userId, binding.keyId, binding.runId, {
    reason,
  });
}

export async function revokeOwnedKey(userId: string, keyId: string) {
  await db.transaction(async (tx) => {
    const [binding] = await tx
      .select()
      .from(schema.cliCredentialBindings)
      .where(
        and(
          eq(schema.cliCredentialBindings.keyId, keyId),
          eq(schema.cliCredentialBindings.userId, userId),
        ),
      )
      .for('update');
    if (!binding) throw new AuthError('key_not_found', 404);
    if (binding.credentialType === 'run_key')
      throw new AuthError('host_managed_credential', 403);
    if (!binding.revokedAt) await revoke(tx, binding, 'explicit');
  });
}

export async function listKeys(userId: string) {
  const rows = await db
    .select({
      binding: schema.cliCredentialBindings,
      enabled: schema.apikey.enabled,
      expiresAt: schema.apikey.expiresAt,
      permissions: schema.apikey.permissions,
    })
    .from(schema.cliCredentialBindings)
    .leftJoin(
      schema.apikey,
      eq(schema.apikey.id, schema.cliCredentialBindings.keyId),
    )
    .where(eq(schema.cliCredentialBindings.userId, userId));
  const epoch = await userEpoch(db, userId);
  const inst = await instance();
  const runIds = rows
    .map((row) => row.binding.runId)
    .filter((id): id is string => id != null);
  const [runRows, grants] = runIds.length
    ? await Promise.all([
        db.query.agentRuns.findMany({ where: { id: { in: runIds } } }),
        db.query.cliRunAuthorizations.findMany({
          where: { runId: { in: runIds } },
        }),
      ])
    : [[], []];
  const liveRuns = new Map(runRows.map((run) => [run.id, run]));
  const liveGrants = new Map(grants.map((grant) => [grant.runId, grant]));
  const runEnded = (b: Binding) => {
    if (b.credentialType !== 'run_key') return false;
    const run = liveRuns.get(b.runId!);
    const grant = liveGrants.get(b.runId!);
    return (
      !run ||
      !grant ||
      grant.revokedAt ||
      grant.epoch !== b.runEpoch ||
      run.runnerId !== b.runnerId ||
      run.sessionId !== b.sessionId ||
      !['running', 'blocked'].includes(run.status) ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= new Date()
    );
  };
  return rows.map(({ binding: b, enabled, expiresAt, permissions }) => ({
    id: b.keyId,
    name: b.displayName,
    credentialType: b.credentialType,
    resources: b.resources,
    scopes: scopesFrom(JSON.parse(permissions ?? '{}')),
    expiresAt: expiresAt ?? b.issuedExpiresAt,
    createdAt: b.createdAt,
    status:
      b.revokedAt ||
      b.userEpoch !== epoch ||
      b.instanceEpoch !== inst.epoch ||
      b.instanceId !== inst.instanceId ||
      runEnded(b)
        ? 'revoked'
        : b.issuedExpiresAt <= new Date() || expiresAt == null
          ? 'expired'
          : !enabled
            ? 'revoked'
            : 'active',
  }));
}
