/**
 * Server-only: per-app key/value store backed by the PLATFORM database
 * (`app_kv`). This is the "simple KV" capability — a place for an app to keep
 * small bits of durable state (tokens, config, counters) WITHOUT provisioning
 * the heavier per-app Postgres (the `database` capability). Inspired by
 * Cloudflare Workers KV / Deno KV but intentionally minimal: durable string
 * values keyed per app, no TTL/caching.
 *
 * Two callers share this module:
 * - the app backend, via the HMAC-signed `/api/app/<id>/kv` route, which always
 *   sees plaintext (it's the app's own data); and
 * - the manage UI, via session-authed server fns, which masks `secret` values.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import { AppError } from '~server/errors';
import { decryptKvSecret, encryptKvSecret } from './kv-secret';

/** Max key length (chars). Keys travel in a URL path segment on the backend API. */
export const KV_KEY_MAX = 512;
/** Max value size (bytes). KV is for small tokens/config, not blobs. */
export const KV_VALUE_MAX_BYTES = 64 * 1024;
/** Soft cap on entries per app, so a runaway loop can't fill the platform DB. */
export const KV_MAX_ENTRIES = 1000;
/**
 * Advisory-lock namespace for per-app KV writes (distinct from the deploy locks:
 * 1 = app deploy, 2 = workflow deploy). Serializes a single app's KV writes so
 * the entry-cap check + insert are atomic.
 */
const APP_KV_LOCK_NS = 3;

/** A KV row, with secret plaintext included only when explicitly revealed. */
export type KvRecord = {
  key: string;
  value: string | null;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

/** An error carrying the HTTP status the KV route should map it to. */
export class KvError extends AppError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = 'KvError';
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
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = trimmed.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new KvError('KV key must contain valid Unicode.', 400);
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new KvError('KV key must contain valid Unicode.', 400);
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

export type KvReadOptions = {
  /** Decrypt encrypted secrets and expose legacy secret plaintext. */
  revealSecrets?: boolean;
};

function storedValue(
  row: typeof schema.appKv.$inferSelect,
  revealSecrets: boolean,
): string | null {
  if (!row.secret) {
    if (row.value === null || row.valueCiphertext !== null) {
      throw new KvError('KV value has an invalid storage state.', 500);
    }
    return row.value;
  }

  // Mask before looking at the envelope. UI/default Agent reads therefore do
  // not decrypt secret data and remain safe even if an envelope is corrupted.
  if (!revealSecrets) return null;

  // Legacy secret rows retain plaintext until the next explicit overwrite.
  if (row.value !== null && row.valueCiphertext === null) return row.value;
  if (row.value === null && row.valueCiphertext !== null) {
    try {
      return decryptKvSecret(
        row.appId,
        row.key,
        row.valueCiphertext,
        KV_VALUE_MAX_BYTES,
      );
    } catch {
      throw new KvError(
        'Unable to decrypt KV secret: stored ciphertext is invalid or SECRET does not match.',
        500,
      );
    }
  }
  throw new KvError('KV secret has an invalid storage state.', 500);
}

function toRecord(
  row: typeof schema.appKv.$inferSelect,
  opts: KvReadOptions = {},
): KvRecord {
  return {
    key: row.key,
    value: storedValue(row, opts.revealSecrets ?? true),
    secret: row.secret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWrittenRecord(
  row: typeof schema.appKv.$inferSelect,
  plaintext: string,
): KvRecord {
  return {
    key: row.key,
    value: plaintext,
    secret: row.secret,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Read a single value (plaintext), or null when the key is unset. */
export async function getKv(
  appId: string,
  key: string,
  opts: KvReadOptions = {},
): Promise<KvRecord | null> {
  const k = normalizeKvKey(key);
  const row = await db.query.appKv.findFirst({
    where: { appId, key: k },
  });
  return row ? toRecord(row, opts) : null;
}

/** List every entry for an app, sorted by key. */
export async function listKv(
  appId: string,
  opts: KvReadOptions = {},
): Promise<KvRecord[]> {
  const rows = await db.query.appKv.findMany({
    where: { appId },
    orderBy: { key: 'asc' },
  });
  return rows.map((row) => toRecord(row, opts));
}

export type KvPage = {
  items: KvRecord[];
  hasMore: boolean;
};

/**
 * Read one keyset-paginated batch. `after` and ordering use the same database
 * collation, so a returned key is a stable cursor even for non-ASCII keys.
 * Fetch one extra row to report whether another batch exists, but never return
 * it to the caller.
 */
export async function listKvPage(
  appId: string,
  opts: { after?: string; limit: number; revealSecrets?: boolean },
): Promise<KvPage> {
  const rows = await db.query.appKv.findMany({
    where: opts.after ? { appId, key: { gt: opts.after } } : { appId },
    orderBy: { key: 'asc' },
    limit: opts.limit + 1,
  });
  return {
    items: rows.slice(0, opts.limit).map((row) => toRecord(row, opts)),
    hasMore: rows.length > opts.limit,
  };
}

/** Number of entries for an app (for the soft cap). */
export async function countKv(appId: string): Promise<number> {
  const rows = await db.query.appKv.findMany({
    where: { appId },
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
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${APP_KV_LOCK_NS}, hashtext(${appId}))`,
      );

      const existing = await tx.query.appKv.findFirst({
        where: { appId, key: k },
        columns: { id: true, secret: true },
      });

      const secret = opts.secret ?? existing?.secret ?? false;
      const stored = secret
        ? {
            secret: true,
            value: null,
            valueCiphertext: encryptKvSecret(
              appId,
              k,
              value,
              KV_VALUE_MAX_BYTES,
            ),
          }
        : { secret: false, value, valueCiphertext: null };

      if (existing) {
        const [row] = await tx
          .update(schema.appKv)
          .set(stored)
          .where(and(eq(schema.appKv.appId, appId), eq(schema.appKv.key, k)))
          .returning();
        // The caller supplied this plaintext in the same operation; do not
        // decrypt the envelope merely to build the write response.
        return toWrittenRecord(row, value);
      }

      const current = await tx.query.appKv.findMany({
        where: { appId },
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
        .values({ appId, key: k, ...stored })
        .returning();
      return toWrittenRecord(row, value);
    });
  } catch (error) {
    if (error instanceof KvError) throw error;
    // Drizzle includes bound parameters in database error messages. A secret
    // write binds the encrypted envelope, so never propagate or attach the
    // original error to a route, internal API, log, or server-function caller.
    throw new KvError('Unable to store KV value.', 500);
  }
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
