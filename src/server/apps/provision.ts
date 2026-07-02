/** Server-only: provision a dedicated Postgres database + role per app. */
import { createHmac } from 'node:crypto';
import postgres from 'postgres';

/** Map an app id (kebab-case) to a safe Postgres database/role name. */
export function appDbName(id: string): string {
  return `app_${id.replace(/[^a-z0-9_]/g, '_')}`;
}

/** Admin connection used to create/drop per-app databases and roles. */
function adminUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error('APP_DATABASE_URL is not set');
  }
  return url;
}

/**
 * Deterministic per-app role password, derived from the platform secret so it
 * never needs to be stored. Rotating BETTER_AUTH_SECRET changes every derived
 * password; `ensureAppDatabase` re-aligns the role password on each cold start,
 * so backends recover on their next boot. Hex output, so it is always safe to
 * embed in a SQL string literal and a connection URL.
 */
function appDbPassword(id: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is not set');
  }
  return createHmac('sha256', secret)
    .update(`app-db-password:${appDbName(id)}`)
    .digest('hex');
}

/**
 * Connection string injected into an app backend as DATABASE_URL. Host and port
 * come from APP_DATABASE_URL, but the credentials are the app's own restricted
 * role — never the admin's. The role owns exactly one database (the app's) and
 * `ensureAppDatabase` revokes PUBLIC connect on it, so untrusted app code that
 * rewrites the database name in this URL cannot reach another app's database or
 * the platform database with these credentials.
 */
export function appDatabaseUrl(id: string): string {
  const name = appDbName(id);
  const url = new URL(adminUrl());
  url.username = name;
  url.password = appDbPassword(id);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Ensure the app's database and restricted role exist, creating them on first
 * use. Also migrates databases provisioned before per-app roles existed:
 * ownership of the database and of any admin-created objects inside it is
 * transferred to the app role. Returns the (restricted) connection string for
 * the app backend.
 */
export async function ensureAppDatabase(id: string): Promise<string> {
  const name = appDbName(id);
  const password = appDbPassword(id);
  // Silence NOTICEs (e.g. "role already granted membership") from the idempotent
  // grants below; they are expected on every re-provision and only add noise.
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    // Role first: CREATE DATABASE ... OWNER requires the role to exist. The
    // name is sanitized above and the password is hex, so both are safe to
    // splice (DDL cannot be parameterized).
    const roles = await admin`select 1 from pg_roles where rolname = ${name}`;
    if (roles.length === 0) {
      await admin.unsafe(
        `create role "${name}" login password '${password}' ` +
          'nosuperuser nocreatedb nocreaterole',
      );
    } else {
      // Re-align after a BETTER_AUTH_SECRET rotation (or a manual edit).
      await admin.unsafe(`alter role "${name}" login password '${password}'`);
    }
    // Membership lets a non-superuser admin create the database with this
    // owner and reassign object ownership below. Harmless for superusers.
    await admin.unsafe(`grant "${name}" to current_user`).catch(() => {});

    const dbs = await admin`select 1 from pg_database where datname = ${name}`;
    if (dbs.length === 0) {
      await admin.unsafe(`create database "${name}" owner "${name}"`);
    } else {
      // Databases provisioned before per-app roles were owned by the admin.
      await admin.unsafe(`alter database "${name}" owner to "${name}"`);
    }
    // Without this, any role in the cluster (e.g. another app's role) could
    // connect via the default PUBLIC grant. The owner's implicit privileges
    // are unaffected.
    await admin.unsafe(
      `revoke connect, temporary on database "${name}" from public`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Objects created before per-app roles are owned by the admin, which would
  // leave the app role unable to ALTER/DROP its own tables. Sweep ownership
  // inside the app database; a no-op when everything is already owned.
  const appDbAdminUrl = new URL(adminUrl());
  appDbAdminUrl.pathname = `/${name}`;
  const appAdmin = postgres(appDbAdminUrl.toString(), { max: 1 });
  try {
    await appAdmin.unsafe(`grant all on schema public to "${name}"`);
    await appAdmin.unsafe(`
      do $$
      declare r record;
      begin
        for r in
          select format('alter table %I.%I owner to %I',
                        schemaname, tablename, '${name}') as cmd
          from pg_tables
          where schemaname not in ('pg_catalog', 'information_schema')
            and tableowner <> '${name}'
          union all
          select format('alter sequence %I.%I owner to %I',
                        schemaname, sequencename, '${name}')
          from pg_sequences
          where schemaname not in ('pg_catalog', 'information_schema')
            and sequenceowner <> '${name}'
          union all
          select format('alter view %I.%I owner to %I',
                        schemaname, viewname, '${name}')
          from pg_views
          where schemaname not in ('pg_catalog', 'information_schema')
            and viewowner <> '${name}'
        loop
          execute r.cmd;
        end loop;
      end $$;
    `);
  } finally {
    await appAdmin.end({ timeout: 5 });
  }

  return appDatabaseUrl(id);
}

/**
 * Boot-time hardening: revoke the default PUBLIC CONNECT grant on the platform
 * database so a per-app role (which authenticates against the same server)
 * can't even open a connection to it — closing the residual catalog-name
 * visibility left after per-app roles were scoped to their own databases. The
 * platform connects as the admin/superuser, which bypasses CONNECT checks, so
 * this never locks the platform out of its own database. Best-effort: a
 * managed provider that forbids this grant change simply keeps the prior
 * (already safe: no data readable) posture.
 */
export async function hardenPlatformDatabase(): Promise<void> {
  const platformUrl = process.env.DATABASE_URL;
  if (!platformUrl) return;
  let dbName: string;
  try {
    dbName = new URL(platformUrl).pathname.replace(/^\//, '');
  } catch {
    return;
  }
  if (!dbName || !/^[a-zA-Z0-9_]+$/.test(dbName)) return;
  const sql = postgres(platformUrl, { max: 1 });
  try {
    await sql.unsafe(`revoke connect on database "${dbName}" from public`);
  } catch (error) {
    console.warn(
      '[provision] could not harden platform database connect:',
      error,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Drop an app's database and role (used when an app is deleted). Best-effort. */
export async function dropAppDatabase(id: string): Promise<void> {
  const name = appDbName(id);
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    // The role owns nothing outside its (now dropped) database.
    await admin.unsafe(`drop role if exists "${name}"`).catch(() => {});
  } finally {
    await admin.end({ timeout: 5 });
  }
}
