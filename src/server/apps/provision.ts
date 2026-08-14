/** Server-only: provision a dedicated Postgres database + role per app. */
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, schema } from '~/db';
import {
  decryptAppDbPassword,
  encryptAppDbPassword,
  generateAppDbPassword,
} from './db-password';

/**
 * Advisory-lock namespace for per-app database provisioning. Existing keyed
 * namespaces 1-5 cover app/workflow deploys, app KV, sidebar, and dashboards.
 */
const APP_DB_PROVISION_LOCK_NS = 6;

/** Session lock spanning provisioning, registration, queries, and deletion. */
const APP_DB_LIFECYCLE_LOCK_NS = 0x48414442;

export const APP_DATABASE_NOT_PROVISIONED_ERROR =
  'App database is not provisioned. Deploy a version with capabilities.database enabled first.';

type AdminConnection = ReturnType<typeof postgres>;

export type AppDatabaseLifecycle = {
  /** Ensure the role/database exist and return the restricted connection URL. */
  ensure(): Promise<string>;
  /** Resolve an already-registered database without creating physical resources. */
  resolve(): Promise<string>;
  /** Drop the physical database and role. */
  drop(): Promise<void>;
};

export type AppDatabaseDeploymentLease = {
  /** Set only when this deployment provisioned the App database. */
  dbName: string | undefined;
  /** Release the lifecycle lock after the deployment row commits or aborts. */
  release(): Promise<void>;
};

const lifecycleChains = new Map<string, Promise<void>>();

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

/** Reserve one in-process lifecycle slot until the returned release runs. */
function reserveLocalLifecycle(id: string): {
  wait: Promise<void>;
  release(): void;
} {
  const previous = lifecycleChains.get(id) ?? Promise.resolve();
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const tail = previous.then(() => gate);
  lifecycleChains.set(id, tail);
  let released = false;
  return {
    wait: previous,
    release() {
      if (released) return;
      released = true;
      resolve();
      void tail.finally(() => {
        if (lifecycleChains.get(id) === tail) lifecycleChains.delete(id);
      });
    },
  };
}

/** Acquire the process-local queue and cross-process PostgreSQL session lock. */
async function acquireAppDatabaseLifecycle(
  id: string,
): Promise<AppDatabaseLifecycle & { release(): Promise<void> }> {
  const local = reserveLocalLifecycle(id);
  await local.wait;

  let admin: AdminConnection | null = null;
  let locked = false;
  try {
    admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    await admin`
      select pg_advisory_lock(
        ${APP_DB_LIFECYCLE_LOCK_NS}, hashtext(${id})
      )
    `;
    locked = true;
  } catch (error) {
    await admin?.end({ timeout: 5 }).catch(() => {});
    local.release();
    throw error;
  }

  const connection = admin;
  let released = false;
  return {
    ensure: () => ensureAppDatabaseUnlocked(id, connection),
    resolve: () => resolveAppDatabaseUrlUnlocked(id, connection),
    drop: () => dropAppDatabaseUnlocked(id, connection),
    async release() {
      if (released) return;
      released = true;
      try {
        if (locked) {
          await connection`
            select pg_advisory_unlock(
              ${APP_DB_LIFECYCLE_LOCK_NS}, hashtext(${id})
            )
          `.catch(() => {});
        }
        await connection.end({ timeout: 5 }).catch(() => {});
      } finally {
        local.release();
      }
    },
  };
}

/** Run one lifecycle operation while creation/query/deletion are serialized. */
export async function withAppDatabaseLifecycle<T>(
  id: string,
  fn: (database: AppDatabaseLifecycle) => Promise<T>,
): Promise<T> {
  const database = await acquireAppDatabaseLifecycle(id);
  try {
    return await fn(database);
  } finally {
    await database.release();
  }
}

/**
 * Ensure the app's database and restricted role exist, creating them on first
 * use. Also migrates databases provisioned before per-app roles existed:
 * ownership of the database and of any admin-created objects inside it is
 * transferred to the app role. The first call generates and stores the app's
 * random encrypted password; later calls decrypt and reuse it.
 */
async function ensureAppDatabaseUnlocked(
  id: string,
  admin: AdminConnection,
): Promise<string> {
  const name = appDbName(id);
  return db.transaction(async (tx) => {
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

    let password: string;
    const roles = await admin`select 1 from pg_roles where rolname = ${name}`;
    const roleExists = roles.length > 0;
    const dbs = await admin`select 1 from pg_database where datname = ${name}`;

    if (app.dbPasswordCiphertext !== null) {
      password = decryptAppDbPassword(id, app.dbPasswordCiphertext);
    } else {
      password = generateAppDbPassword();
      const dbPasswordCiphertext = encryptAppDbPassword(id, password);
      const [updated] = await tx
        .update(schema.apps)
        .set({ dbPasswordCiphertext })
        .where(eq(schema.apps.id, id))
        .returning({ id: schema.apps.id });
      if (!updated) throw new Error(`App "${id}" not found.`);
    }

    // Role first: CREATE DATABASE ... OWNER requires it to exist. Passwords
    // are validated 64-character lowercase hex strings by db-password.ts,
    // so interpolation is safe where PostgreSQL cannot parameterize DDL.
    if (roleExists) {
      await admin.unsafe(`alter role "${name}" login password '${password}'`);
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

    return appDatabaseUrl(id, password);
  });
}

/** Provision only through the serialized lifecycle entrypoint. */
export function ensureAppDatabase(id: string): Promise<string> {
  return withAppDatabaseLifecycle(id, (database) => database.ensure());
}

async function resolveAppDatabaseUrlUnlocked(
  id: string,
  admin: AdminConnection,
): Promise<string> {
  const app = await db.query.apps.findFirst({
    where: (row, { eq: equal }) => equal(row.id, id),
    columns: { dbName: true, dbPasswordCiphertext: true },
  });
  if (!app?.dbName) throw new Error(APP_DATABASE_NOT_PROVISIONED_ERROR);
  if (app.dbPasswordCiphertext !== null) {
    return appDatabaseUrl(
      id,
      decryptAppDbPassword(id, app.dbPasswordCiphertext),
    );
  }

  // Rows registered before encrypted credentials were introduced are adapted
  // in place, but only when both retained physical resources still exist. This
  // compatibility path must never recreate a database from a read/query call.
  const name = appDbName(id);
  const [roles, databases] = await Promise.all([
    admin`select 1 from pg_roles where rolname = ${name}`,
    admin`select 1 from pg_database where datname = ${name}`,
  ]);
  if (roles.length === 0 || databases.length === 0) {
    throw new Error(APP_DATABASE_NOT_PROVISIONED_ERROR);
  }
  return ensureAppDatabaseUnlocked(id, admin);
}

/** Resolve a retained database URL without provisioning or recreating it. */
export function resolveAppDatabaseUrl(id: string): Promise<string> {
  return withAppDatabaseLifecycle(id, (database) => database.resolve());
}

/** Provision under a lease held until the deployment row is committed. */
export async function beginAppDatabaseDeployment(
  id: string,
  enabled: boolean,
): Promise<AppDatabaseDeploymentLease> {
  if (!enabled) {
    return { dbName: undefined, release: async () => {} };
  }

  const database = await acquireAppDatabaseLifecycle(id);
  try {
    await database.ensure();
    return { dbName: appDbName(id), release: database.release };
  } catch (error) {
    await database.release();
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

async function dropAppDatabaseUnlocked(
  id: string,
  admin: AdminConnection,
): Promise<void> {
  const name = appDbName(id);
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  // Propagate role cleanup failure so manual deletion retains its retry marker.
  await admin.unsafe(`drop role if exists "${name}"`);
}

/** Drop an app database under the shared lifecycle lock. */
export function dropAppDatabase(id: string): Promise<void> {
  return withAppDatabaseLifecycle(id, (database) => database.drop());
}
