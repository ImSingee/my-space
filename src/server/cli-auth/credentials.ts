/**
 * Server-only opaque credentials, stored entirely in Better Auth's `apikey`
 * table. `permissions` holds the scopes; `metadata` holds the credential type,
 * resource range and Run context. Both are written only by this server: the
 * plugin's HTTP routes are sealed (see `isSealedAuthPath`).
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '~auth/server';
import {
  grantSchema,
  issuanceEnabled,
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

const CONFIG_ID = 'hatch';
const LIVE_RUN_STATUSES = ['running', 'blocked'];

const runContextSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    runnerId: z.string().min(1),
  })
  .strict();
const metadataSchema = z
  .object({
    credentialType: z.enum(['interactive_key', 'user_api_key', 'run_key']),
    resources: resourceRangeSchema,
    run: runContextSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.credentialType === 'run_key') === Boolean(value.run),
    'Only Run keys carry a Run context',
  );
type KeyMetadata = z.infer<typeof metadataSchema>;
type Connection = TX | typeof db;
type KeyRow = typeof schema.apikey.$inferSelect;

/** A key without valid Hatch metadata has no authority, whatever the plugin says. */
export function readMetadata(raw: string | null): KeyMetadata | null {
  try {
    let value: unknown = JSON.parse(raw ?? 'null');
    // Older plugin versions stored metadata JSON-encoded twice.
    if (typeof value === 'string') value = JSON.parse(value);
    const parsed = metadataSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function readScopes(raw: string | null): CliScope[] {
  try {
    return scopesFrom(JSON.parse(raw ?? '{}'));
  } catch {
    return [];
  }
}

export type CliPrincipal = {
  userId: string;
  credentialId: string;
  credentialType: CredentialType;
  scopes: CliScope[];
  resources: ResourceRange;
  context: z.infer<typeof runContextSchema> | null;
};

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
  tx: Connection = db,
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

/**
 * A password change ends every credential issued before it. Better Auth bumps
 * the credential account's `updatedAt` on every password write (change, reset
 * or set), so comparing against it covers all of them without hooks.
 */
async function passwordChangedAt(conn: Connection, userId: string) {
  const [account] = await conn
    .select({ updatedAt: schema.account.updatedAt })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, 'credential'),
      ),
    );
  return account?.updatedAt ?? null;
}

/** Why a stored key no longer grants anything, or null while it is usable. */
async function keyProblem(
  key: KeyRow | undefined,
  metadata: KeyMetadata | null,
  conn: Connection,
  lock: boolean,
): Promise<AuthError | null> {
  const invalid = new AuthError('invalid_credential', 401);
  if (
    !key ||
    key.configId !== CONFIG_ID ||
    !key.enabled ||
    !key.expiresAt ||
    key.expiresAt <= new Date() ||
    !metadata ||
    !readScopes(key.permissions).length
  )
    return invalid;
  const userQuery = conn
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, key.referenceId));
  const [user] = await (lock ? userQuery.for('share') : userQuery);
  if (!user) return invalid;
  const changed = await passwordChangedAt(conn, key.referenceId);
  if (changed && changed > key.createdAt) return invalid;
  if (metadata.run) {
    const runQuery = conn
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, metadata.run.runId));
    const [run] = await (lock ? runQuery.for('share') : runQuery);
    if (
      !run ||
      run.startedByUserId !== key.referenceId ||
      run.sessionId !== metadata.run.sessionId ||
      run.runnerId !== metadata.run.runnerId ||
      !LIVE_RUN_STATUSES.includes(run.status) ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= new Date()
    )
      return new AuthError('run_authorization_ended', 401);
  }
  return null;
}

/**
 * Load a key's current authority. With `lock`, the key, owner and Run rows are
 * share-locked so a concurrent revocation serializes with the caller's commit.
 */
async function loadPrincipal(
  keyId: string,
  conn: Connection,
  lock = false,
): Promise<CliPrincipal> {
  const query = conn
    .select()
    .from(schema.apikey)
    .where(eq(schema.apikey.id, keyId));
  const [key] = await (lock ? query.for('share') : query);
  const metadata = readMetadata(key?.metadata ?? null);
  const problem = await keyProblem(key, metadata, conn, lock);
  if (problem) throw problem;
  return {
    userId: key!.referenceId,
    credentialId: key!.id,
    credentialType: metadata!.credentialType,
    scopes: readScopes(key!.permissions),
    resources: metadata!.resources,
    context: metadata!.run ?? null,
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
  // The plugin checks the hash, `enabled`, expiry and the per-key rate limit.
  const verified = await auth.api.verifyApiKey({
    body: { key: match[1], configId: CONFIG_ID },
  });
  if (verified.error?.code === 'RATE_LIMITED')
    throw new AuthError('rate_limited', 429);
  if (!verified.valid || !verified.key)
    throw new AuthError('invalid_credential', 401);
  return loadPrincipal(verified.key.id, db);
}

export function requirePermission(
  principal: CliPrincipal,
  scope: CliScope,
  resourceId?: string,
) {
  if (!principal.scopes.includes(scope))
    throw new AuthError('insufficient_scope', 403);
  const kind = scope.startsWith('app.') ? 'apps' : 'workflows';
  if (
    principal.resources.mode === 'ids' &&
    (scope.endsWith('.create') ||
      (resourceId != null && !principal.resources[kind].includes(resourceId)))
  )
    throw new AuthError('resource_forbidden', 403);
}

/** Recheck a captured principal inside the transaction that commits a write. */
export async function authorizeCommit(
  principal: CliPrincipal,
  scope: CliScope,
  resourceId: string | undefined,
  tx: TX,
) {
  requirePermission(
    await loadPrincipal(principal.credentialId, tx, true),
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
  run?: z.infer<typeof runContextSchema>;
};

/** One plugin call: the key is complete, and authoritative, once it exists. */
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
  await validateResources(input.resources);
  const metadata: KeyMetadata = {
    credentialType: input.credentialType,
    resources: input.resources,
    ...(input.run ? { run: input.run } : {}),
  };
  const key = await auth.api.createApiKey({
    body: {
      configId: CONFIG_ID,
      userId: input.userId,
      name: input.name,
      expiresIn: input.expiresIn,
      permissions: permissionsFor(input.scopes),
      metadata,
      rateLimitEnabled: true,
      rateLimitMax: 120,
      rateLimitTimeWindow: 60000,
    },
  });
  return {
    id: key.id,
    token: key.key,
    credentialType: input.credentialType,
    scopes: input.scopes,
    resources: input.resources,
    expiresAt: key.expiresAt,
  };
}

async function ownedKey(userId: string, keyId: string) {
  const key = await db.query.apikey.findFirst({
    where: { id: keyId, referenceId: userId, configId: CONFIG_ID },
  });
  const metadata = readMetadata(key?.metadata ?? null);
  if (!key || !metadata) throw new AuthError('key_not_found', 404);
  if (metadata.credentialType === 'run_key')
    throw new AuthError('host_managed_credential', 403);
  return { key, metadata };
}

/** Idempotent. Run keys belong to their Host and are never revoked here. */
export async function revokeOwnedKey(userId: string, keyId: string) {
  await ownedKey(userId, keyId);
  await db
    .update(schema.apikey)
    .set({ enabled: false })
    .where(eq(schema.apikey.id, keyId));
}

/**
 * Same scopes and resources with a new secret and expiration. Of concurrent
 * rotations, only the one that disables the old key keeps its new key.
 */
export async function rotateOwnedKey(
  userId: string,
  keyId: string,
  expiresIn: number,
) {
  const { key, metadata } = await ownedKey(userId, keyId);
  if (await keyProblem(key, metadata, db, false))
    throw new AuthError('rotation_conflict', 409);
  const next = await issueCredential({
    userId,
    credentialType: metadata.credentialType,
    name: key.name ?? 'Hatch key',
    expiresIn,
    scopes: readScopes(key.permissions),
    resources: metadata.resources,
  });
  const disabled = await db
    .update(schema.apikey)
    .set({ enabled: false })
    .where(and(eq(schema.apikey.id, keyId), eq(schema.apikey.enabled, true)))
    .returning({ id: schema.apikey.id });
  if (!disabled.length) {
    await db
      .update(schema.apikey)
      .set({ enabled: false })
      .where(eq(schema.apikey.id, next.id));
    throw new AuthError('rotation_conflict', 409);
  }
  return next;
}

export async function listKeys(userId: string) {
  const keys = await db.query.apikey.findMany({
    where: { referenceId: userId, configId: CONFIG_ID },
    orderBy: { createdAt: 'desc' },
  });
  const rows = await Promise.all(
    keys.map(async (key) => {
      const metadata = readMetadata(key.metadata);
      if (!metadata) return null;
      const expired = !key.expiresAt || key.expiresAt <= new Date();
      const problem = expired
        ? null
        : await keyProblem(key, metadata, db, false);
      return {
        id: key.id,
        name: key.name,
        credentialType: metadata.credentialType,
        scopes: readScopes(key.permissions),
        resources: metadata.resources,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        status: expired ? 'expired' : problem ? 'revoked' : 'active',
      };
    }),
  );
  return rows.filter((row) => row !== null);
}
