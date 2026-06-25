/** Server-only: provision a dedicated Postgres database per subapp. */
import postgres from 'postgres';

/** Map a subapp id (kebab-case) to a safe Postgres database name. */
export function subappDbName(id: string): string {
  return `subapp_${id.replace(/[^a-z0-9_]/g, '_')}`;
}

/** Connection string injected into a subapp backend as DATABASE_URL. */
export function subappDatabaseUrl(id: string): string {
  const host = process.env.PLATFORM_PG_HOST ?? 'localhost';
  const port = process.env.PLATFORM_PG_PORT ?? '5432';
  return `postgres://postgres@${host}:${port}/${subappDbName(id)}`;
}

function adminUrl(): string {
  const url = process.env.PLATFORM_PG_ADMIN_URL;
  if (!url) {
    throw new Error('PLATFORM_PG_ADMIN_URL is not set');
  }
  return url;
}

/**
 * Ensure the subapp's database exists, creating it on first use.
 * Returns the connection string for the subapp backend.
 */
export async function ensureSubappDatabase(id: string): Promise<string> {
  const name = subappDbName(id);
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    const rows = await admin`
      select 1 from pg_database where datname = ${name}
    `;
    if (rows.length === 0) {
      // datname is sanitized above; CREATE DATABASE cannot be parameterized.
      await admin.unsafe(`create database "${name}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  return subappDatabaseUrl(id);
}

/** Drop a subapp's database (used when a subapp is deleted). Best-effort. */
export async function dropSubappDatabase(id: string): Promise<void> {
  const name = subappDbName(id);
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
