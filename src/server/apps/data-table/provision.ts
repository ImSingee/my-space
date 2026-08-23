/** Provision a platform-managed, isolated Postgres database for Data Tables. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, schema } from '~/db';
import {
  decryptAppDataDbPassword,
  encryptAppDataDbPassword,
  generateAppDataDbPassword,
} from '../db-password';

const DATA_CUTOVER_LOCK_NAMESPACE = 0x48445443;
const DATA_PROVISION_LOCK_NAMESPACE = 0x48445450;
const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
const DATA_DB_PREFIX = 'hatch_data_';
const DATA_DB_HASH_LENGTH = 24;

function adminUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error('APP_DATABASE_URL is not set');
  return url;
}

function platformUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

export function appDataDbName(id: string): string {
  // Keep managed Data databases in a namespace that can never overlap the
  // regular App DB `app_*` namespace. Include a digest of the original id so
  // normalization (hyphen -> underscore) and PostgreSQL's 63-byte identifier
  // limit cannot silently alias two ordinary app ids onto the same role/DB.
  // Every emitted character is ASCII, so the character and byte limits match.
  const digest = createHash('sha256')
    .update(`app-data-db-name:${id}`)
    .digest('hex')
    .slice(0, DATA_DB_HASH_LENGTH);
  const suffix = `_${digest}`;
  const stemLength =
    POSTGRES_IDENTIFIER_MAX_LENGTH - DATA_DB_PREFIX.length - suffix.length;
  const normalized = id.replace(/[^a-z0-9_]/g, '_');
  const stem = normalized.slice(0, stemLength) || 'app';
  return `${DATA_DB_PREFIX}${stem}${suffix}`;
}

export function appDataDatabaseUrl(id: string, password: string): string {
  const name = appDataDbName(id);
  const url = new URL(adminUrl());
  url.username = name;
  url.password = password;
  url.pathname = `/${name}`;
  return url.toString();
}

/** Resolve the stored credential without creating database resources. */
export async function resolveAppDataDatabaseUrl(id: string): Promise<string> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { dataDbPasswordCiphertext: true },
  });
  if (!app) throw new Error(`App "${id}" not found.`);
  if (app.dataDbPasswordCiphertext === null) {
    throw new Error(`Data Table database for App "${id}" is not provisioned.`);
  }
  return appDataDatabaseUrl(
    id,
    decryptAppDataDbPassword(id, app.dataDbPasswordCiphertext),
  );
}

/**
 * Check whether the managed Data database exists through the admin database.
 *
 * Recovery callers use this before opening the per-App database so a database
 * that was never provisioned is distinguishable from a provisioned database
 * that is temporarily unreachable. Callers that need a stable answer across a
 * lifecycle operation must hold {@link withAppDataCutoverLock}.
 */
export async function appDataDatabaseExists(id: string): Promise<boolean> {
  const name = appDataDbName(id);
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin<{ exists: boolean }[]>`
      select exists(
        select 1 from pg_database where datname = ${name}
      ) as exists
    `;
    return row?.exists ?? false;
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Serialize the short migration + activation cutover across platform processes.
 *
 * The lock lives in the always-present platform database because a first
 * deployment does not have an App Data database yet. It is session-scoped so it
 * can span both database transactions involved in one cutover; closing the
 * connection also releases it after a process crash.
 */
export async function withAppDataCutoverLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const platform = postgres(platformUrl(), { max: 1, onnotice: () => {} });
  let locked = false;
  try {
    await platform`
      select pg_advisory_lock(
        ${DATA_CUTOVER_LOCK_NAMESPACE}, hashtext(${id})
      )
    `;
    locked = true;
    return await fn();
  } finally {
    if (locked) {
      await platform`
        select pg_advisory_unlock(
          ${DATA_CUTOVER_LOCK_NAMESPACE}, hashtext(${id})
        )
      `.catch(() => {});
    }
    await platform.end({ timeout: 5 }).catch(() => {});
  }
}

export async function ensureAppDataDatabase(id: string): Promise<string> {
  const name = appDataDbName(id);
  return db.transaction(async (tx) => {
    // Serialize password creation with role DDL. Without this, concurrent first
    // deployments could persist one random password while the role ends up with
    // another.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
        ${DATA_PROVISION_LOCK_NAMESPACE}, hashtext(${id})
      )`,
    );

    const app = await tx.query.apps.findFirst({
      where: { id },
      columns: { dataDbPasswordCiphertext: true },
    });
    if (!app) throw new Error(`App "${id}" not found.`);

    let password: string;
    if (app.dataDbPasswordCiphertext === null) {
      password = generateAppDataDbPassword();
      const dataDbPasswordCiphertext = encryptAppDataDbPassword(id, password);
      const [updated] = await tx
        .update(schema.apps)
        .set({ dataDbName: name, dataDbPasswordCiphertext })
        .where(eq(schema.apps.id, id))
        .returning({ id: schema.apps.id });
      if (!updated) throw new Error(`App "${id}" not found.`);
    } else {
      password = decryptAppDataDbPassword(id, app.dataDbPasswordCiphertext);
    }

    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    let locked = false;
    try {
      await admin`
        select pg_advisory_lock(
          ${DATA_PROVISION_LOCK_NAMESPACE}, hashtext(${name})
        )
      `;
      locked = true;
      const roles = await admin`select 1 from pg_roles where rolname = ${name}`;
      if (roles.length === 0) {
        await admin.unsafe(
          `create role "${name}" login password '${password}' ` +
            'nosuperuser nocreatedb nocreaterole',
        );
      } else {
        await admin.unsafe(`alter role "${name}" login password '${password}'`);
      }
      await admin.unsafe(`grant "${name}" to current_user`).catch(() => {});
      const dbs =
        await admin`select 1 from pg_database where datname = ${name}`;
      if (dbs.length === 0) {
        await admin.unsafe(`create database "${name}" owner "${name}"`);
      } else {
        await admin.unsafe(`alter database "${name}" owner to "${name}"`);
      }
      await admin.unsafe(
        `revoke connect, temporary on database "${name}" from public`,
      );
    } finally {
      if (locked) {
        await admin`
          select pg_advisory_unlock(
            ${DATA_PROVISION_LOCK_NAMESPACE}, hashtext(${name})
          )
        `.catch(() => {});
      }
      await admin.end({ timeout: 5 }).catch(() => {});
    }
    return appDataDatabaseUrl(id, password);
  });
}

export async function dropAppDataDatabase(id: string): Promise<void> {
  const name = appDataDbName(id);
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  let locked = false;
  try {
    await admin`
      select pg_advisory_lock(
        ${DATA_PROVISION_LOCK_NAMESPACE}, hashtext(${name})
      )
    `;
    locked = true;
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`drop role if exists "${name}"`);
  } finally {
    if (locked) {
      await admin`
        select pg_advisory_unlock(
          ${DATA_PROVISION_LOCK_NAMESPACE}, hashtext(${name})
        )
      `.catch(() => {});
    }
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}
