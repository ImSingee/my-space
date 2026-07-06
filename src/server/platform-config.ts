/**
 * Server-only: typed access to global platform settings stored in the
 * `platform_config` KV table.
 *
 * The table's `value` column is free-form `jsonb`, so adding a new setting
 * never needs a migration. But "generic storage" must not become "arbitrary
 * state": every key that may be read or written is declared in the registry
 * below with a Zod schema and a default. Callers reference keys through this
 * module only — nothing else touches `platform_config` — so the store stays
 * strongly typed and a corrupt/legacy row can never leak a bad value into the
 * app (it falls back to a declared per-key value instead).
 *
 * NOTE: imports here stay relative (`../db`), not `~/db`. This module is
 * reachable from `src/auth/server.ts`, which the Better Auth CLI loads
 * directly and cannot resolve the `~` path alias for.
 */
import { z } from 'zod';
import { db, schema } from '../db';
import type { JsonValue } from '../db/schema';

type ConfigEntry<T> = {
  schema: z.ZodType<T>;
  /** Value used when no row exists (fresh install / key never written). */
  fallback: T;
  /**
   * Value used when a row exists but fails validation. Defaults to
   * `fallback`; set it separately when the two states shouldn't behave the
   * same — e.g. a security toggle that must default open on a fresh install
   * but fail closed if its stored value is corrupted.
   */
  invalidFallback?: T;
};

/**
 * The complete set of platform settings. Add a new key here (with its schema
 * and default) to introduce a setting — no schema migration required.
 */
const REGISTRY = {
  /**
   * Whether self-service sign-up is open. When false, only existing users can
   * sign in; the sign-up flow is rejected server-side (see the Better Auth
   * create hook) and hidden on the login page. Defaults to open so a fresh
   * deploy can bootstrap its first (owner) account — but a corrupted stored
   * value fails closed: the row only exists because someone set the toggle,
   * and silently reopening sign-up is the worse failure.
   */
  'auth.allowSignup': {
    schema: z.boolean(),
    fallback: true,
    invalidFallback: false,
  } satisfies ConfigEntry<boolean>,
} as const;

export type PlatformConfigKey = keyof typeof REGISTRY;
export type PlatformConfigValue<K extends PlatformConfigKey> = z.infer<
  (typeof REGISTRY)[K]['schema']
>;

/**
 * Read a platform setting. A missing row yields the key's `fallback`; a row
 * whose stored value no longer matches the schema (e.g. left over from an
 * older format) yields its `invalidFallback` (or `fallback` when not
 * declared). Never throws.
 */
export async function getPlatformConfig<K extends PlatformConfigKey>(
  key: K,
): Promise<PlatformConfigValue<K>> {
  const entry = REGISTRY[key];
  const row = await db.query.platformConfig.findFirst({
    where: (c, { eq }) => eq(c.key, key),
  });
  if (!row) return entry.fallback as PlatformConfigValue<K>;

  const parsed = entry.schema.safeParse(row.value);
  if (!parsed.success) {
    console.warn(
      `[platform-config] "${key}" has an invalid stored value; ` +
        'using its fallback.',
      parsed.error.issues,
    );
    return (entry.invalidFallback ?? entry.fallback) as PlatformConfigValue<K>;
  }
  return parsed.data as PlatformConfigValue<K>;
}

/**
 * Persist a platform setting. The value is validated against the key's schema
 * before it is written, so a typed call site is the only way to change it.
 */
export async function setPlatformConfig<K extends PlatformConfigKey>(
  key: K,
  value: PlatformConfigValue<K>,
): Promise<void> {
  const entry = REGISTRY[key];
  const validated = entry.schema.parse(value) as JsonValue;
  await db
    .insert(schema.platformConfig)
    .values({ key, value: validated })
    .onConflictDoUpdate({
      target: schema.platformConfig.key,
      set: { value: validated, updatedAt: new Date() },
    });
}
