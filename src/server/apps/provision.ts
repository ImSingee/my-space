/** Server-only: provision a dedicated Postgres database + role per app. */
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, schema } from '~/db';
import {
  decryptAppDbPassword,
  encryptAppDbPassword,
  generateAppDbPassword,
  legacyAppDbPassword,
} from './db-password';

/**
 * Advisory-lock namespace for per-app database provisioning. Existing keyed
 * namespaces 1-5 cover app/workflow deploys, app KV, sidebar, and dashboards.
 */
const APP_DB_PROVISION_LOCK_NS = 6;

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
 * Connection string injected into an app backend as DATABASE_URL. Host and port
 * come from APP_DATABASE_URL, but the credentials are the app's own restricted
 * role — never the admin's. The role owns exactly one database (the app's) and
 * `ensureAppDatabase` revokes PUBLIC connect on it, so untrusted app code that
 * rewrites the database name in this URL cannot reach another app's database or
 * the platform database with these credentials.
 */
export function appDatabaseUrl(id: string, password: string): string {
  const name = appDbName(id);
  const url = new URL(adminUrl());
  url.username = name;
  url.password = password;
  url.pathname = `/${name}`;
  return url.toString();
}

export type EnsureAppDatabaseResult = {
  url: string;
  /** True only when this call upgraded a legacy NULL credential. */
  passwordMigrated: boolean;
};

/**
 * Ensure the app's database and restricted role exist, creating them on first
 * use. Also migrates databases provisioned before per-app roles existed:
 * ownership of the database and of any admin-created objects inside it is
 * transferred to the app role. A NULL stored credential is upgraded to one
 * random, encrypted password during this call; an existing role's legacy HMAC
 * password is retained only as the failure-recovery target for that upgrade.
 */
export async function ensureAppDatabase(
  id: string,
): Promise<EnsureAppDatabaseResult> {
  const name = appDbName(id);
  let legacyPasswordToRestore: string | null = null;
  let passwordMigrationAttempted = false;

  try {
    return await db.transaction(async (tx) => {
      // Password creation and role DDL must be serialized together. Otherwise
      // two cold starts could mint different random values and leave the row
      // disagreeing with the password most recently applied to the role.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(
          ${APP_DB_PROVISION_LOCK_NS}, hashtext(${id})
        )`,
      );

      const app = await tx.query.apps.findFirst({
        where: (s, { eq: e }) => e(s.id, id),
        columns: { dbPasswordCiphertext: true },
      });
      if (!app) throw new Error(`App "${id}" not found.`);

      // Silence expected NOTICEs from idempotent grants on every re-provision.
      const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
      let password: string;
      let passwordMigrated = false;
      try {
        const roles =
          await admin`select 1 from pg_roles where rolname = ${name}`;
        const roleExists = roles.length > 0;
        const dbs =
          await admin`select 1 from pg_database where datname = ${name}`;

        if (app.dbPasswordCiphertext !== null) {
          password = decryptAppDbPassword(id, app.dbPasswordCiphertext);
        } else {
          passwordMigrationAttempted = true;
          // A pre-column role is expected to have the exact legacy HMAC
          // password. Remember it before rotating so a failed cross-database
          // upgrade can restore the still-running old backend's credential.
          if (roleExists) {
            legacyPasswordToRestore = legacyAppDbPassword(name);
          }
          password = generateAppDbPassword();
          const dbPasswordCiphertext = encryptAppDbPassword(id, password);
          const [updated] = await tx
            .update(schema.apps)
            .set({ dbPasswordCiphertext })
            .where(eq(schema.apps.id, id))
            .returning({ id: schema.apps.id });
          if (!updated) throw new Error(`App "${id}" not found.`);
          passwordMigrated = true;
        }

        // Role first: CREATE DATABASE ... OWNER requires it to exist. Passwords
        // are validated 64-character lowercase hex strings by db-password.ts,
        // so interpolation is safe where PostgreSQL cannot parameterize DDL.
        if (roleExists) {
          await admin.unsafe(
            `alter role "${name}" login password '${password}'`,
          );
        } else {
          await admin.unsafe(
            `create role "${name}" login password '${password}' ` +
              'nosuperuser nocreatedb nocreaterole',
          );
        }
        // Membership lets a non-superuser admin create the database with this
        // owner and reassign object ownership below. Harmless for superusers.
        await admin.unsafe(`grant "${name}" to current_user`).catch(() => {});

        if (dbs.length === 0) {
          await admin.unsafe(`create database "${name}" owner "${name}"`);
        } else {
          // Databases provisioned before per-app roles were owned by the admin.
          await admin.unsafe(`alter database "${name}" owner to "${name}"`);
        }
        // Without this, another app role could connect through PUBLIC's default
        // grant. The owner's implicit privileges are unaffected.
        await admin.unsafe(
          `revoke connect, temporary on database "${name}" from public`,
        );
      } finally {
        await admin.end({ timeout: 5 });
      }

      // Objects created before per-app roles are owned by the admin, which
      // would leave the app unable to ALTER/DROP its own tables. Sweep their
      // ownership; this is a no-op after the first successful provisioning.
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

      return {
        url: appDatabaseUrl(id, password),
        passwordMigrated,
      };
    });
  } catch (error) {
    if (passwordMigrationAttempted) {
      try {
        const recovered = await db.transaction(async (tx) => {
          // Reacquire the same lock before inspecting or compensating. A retry
          // may already be migrating this app; an unlocked NULL read followed
          // by HMAC restoration could overwrite the retry's freshly set role.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(
              ${APP_DB_PROVISION_LOCK_NS}, hashtext(${id})
            )`,
          );
          const app = await tx.query.apps.findFirst({
            where: (s, { eq: e }) => e(s.id, id),
            columns: { dbPasswordCiphertext: true },
          });
          if (!app) return null;

          if (app.dbPasswordCiphertext !== null) {
            // COMMIT may have succeeded even when the client received an error,
            // or a queued retry may have completed first. Treat the durable
            // credential as success so the caller still refreshes its backend.
            const password = decryptAppDbPassword(id, app.dbPasswordCiphertext);
            return {
              url: appDatabaseUrl(id, password),
              passwordMigrated: true,
            } satisfies EnsureAppDatabaseResult;
          }

          if (legacyPasswordToRestore) {
            const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
            try {
              await admin.unsafe(
                `alter role "${name}" login password '${legacyPasswordToRestore}'`,
              );
            } finally {
              await admin.end({ timeout: 5 });
            }
          }
          return null;
        });
        if (recovered) return recovered;
      } catch {
        console.warn(
          `[provision] could not reconcile failed password migration for "${id}"`,
        );
      }
    }
    throw error;
  }
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
