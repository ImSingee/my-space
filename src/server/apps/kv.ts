/**
 * Server-only: per-app key/value store backed by the PLATFORM database
 * (`app_kv`). This is the "simple KV" capability — a place for an app to keep
 * small bits of durable state (tokens, config, counters) WITHOUT provisioning
 * the heavier per-app Postgres (the `database` capability). Inspired by
 * Cloudflare Workers KV / Deno KV but intentionally minimal: durable string
 * values keyed per app, no TTL/caching.
 *
 * Two callers share this module:
 * - the app backend, via the HMAC-signed `/api/apps/<id>/kv` route, which always
 *   sees plaintext (it's the app's own data); and
 * - the manage UI, via session-authed server fns, which masks `secret` values.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '~/db';

/** Max key length (chars). Keys travel in a URL path segment on the backend API. */
export const KV_KEY_MAX = 512;
/** Max value size (bytes). KV is for small tokens/config, not blobs — see storage. */
export const KV_VALUE_MAX_BYTES = 64 * 1024;
/** Soft cap on entries per app, so a runaway loop can't fill the platform DB. */
export const KV_MAX_ENTRIES = 1000;
/**
 * Advisory-lock namespace for per-app KV writes (distinct from the deploy locks:
 * 1 = app deploy, 2 = workflow deploy). Serializes a single app's KV writes so
 * the entry-cap check + insert are atomic.
 */
const APP_KV_LOCK_NS = 3;

/** A KV row as returned to trusted callers (full plaintext value). */
export type KvRecord = {
  key: string;
  value: string;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

/** An error carrying the HTTP status the KV route should map it to. */
export class KvError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'KvError';
    this.status = status;
  }
}

/** Validate + trim a key (shared by every operation). */
export function normalizeKvKey(key: string): string {
  const trimmed = (key ?? '').trim();
  if (!trimmed) throw new KvError('KV key is required.', 400);
  if (trimmed.length > KV_KEY_MAX) {
    throw new KvError(`KV key too long (max ${KV_KEY_MAX} chars).`, 400);
  }
  // Control characters would corrupt the URL path / UI; reject them up front.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new KvError('KV key may not contain control characters.', 400);
    }
  }
  return trimmed;
}

function validateValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new KvError('KV value must be a string.', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > KV_VALUE_MAX_BYTES) {
    throw new KvError(
      `KV value too large (max ${KV_VALUE_MAX_BYTES} bytes).`,
      413,
    );
  }
}

function toRecord(row: typeof schema.appKv.$inferSelect): KvRecord {
  return {
    key: row.key,
    value: row.value,
    secret: row.secret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Read a single value (plaintext), or null when the key is unset. */
export async function getKv(
  appId: string,
  key: string,
): Promise<KvRecord | null> {
  const k = normalizeKvKey(key);
  const row = await db.query.appKv.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.appId, appId), e(t.key, k)),
  });
  return row ? toRecord(row) : null;
}

/** List every entry for an app (plaintext), sorted by key. */
export async function listKv(appId: string): Promise<KvRecord[]> {
  const rows = await db.query.appKv.findMany({
    where: (t, { eq: e }) => e(t.appId, appId),
    orderBy: (t, { asc }) => [asc(t.key)],
  });
  return rows.map(toRecord);
}

/** Number of entries for an app (for the soft cap). */
export async function countKv(appId: string): Promise<number> {
  const rows = await db.query.appKv.findMany({
    where: (t, { eq: e }) => e(t.appId, appId),
    columns: { id: true },
  });
  return rows.length;
}

/**
 * Upsert a value. On update, `secret` is preserved unless explicitly provided
 * (so overwriting a secret's value via the manage UI keeps it secret); on insert
 * it defaults to false. Enforces the per-app entry cap only when adding a new key.
 */
export async function setKv(
  appId: string,
  key: string,
  value: string,
  opts: { secret?: boolean } = {},
): Promise<KvRecord> {
  const k = normalizeKvKey(key);
  validateValue(value);

  // Serialize this app's KV writes with a transaction-scoped advisory lock so
  // the existence check, entry-cap count, and insert/update are one atomic step.
  // Without it, concurrent new-key writes could each pass the cap check and blow
  // past KV_MAX_ENTRIES, and racing inserts of the same key could trip the
  // unique index. The lock auto-releases on commit/rollback.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${APP_KV_LOCK_NS}, hashtext(${appId}))`,
    );

    const existing = await tx.query.appKv.findFirst({
      where: (t, { eq: e, and: a }) => a(e(t.appId, appId), e(t.key, k)),
      columns: { id: true },
    });

    if (existing) {
      const [row] = await tx
        .update(schema.appKv)
        .set({
          value,
          ...(opts.secret === undefined ? {} : { secret: opts.secret }),
        })
        .where(and(eq(schema.appKv.appId, appId), eq(schema.appKv.key, k)))
        .returning();
      return toRecord(row);
    }

    const current = await tx.query.appKv.findMany({
      where: (t, { eq: e }) => e(t.appId, appId),
      columns: { id: true },
    });
    if (current.length >= KV_MAX_ENTRIES) {
      throw new KvError(
        `KV entry limit reached (max ${KV_MAX_ENTRIES} keys per app).`,
        409,
      );
    }
    const [row] = await tx
      .insert(schema.appKv)
      .values({ appId, key: k, value, secret: opts.secret ?? false })
      .returning();
    return toRecord(row);
  });
}

/** Delete a key. Returns true when a row was removed. */
export async function deleteKv(appId: string, key: string): Promise<boolean> {
  const k = normalizeKvKey(key);
  const deleted = await db
    .delete(schema.appKv)
    .where(and(eq(schema.appKv.appId, appId), eq(schema.appKv.key, k)))
    .returning({ id: schema.appKv.id });
  return deleted.length > 0;
}
