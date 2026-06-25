/** Server-only: provision a dedicated Postgres database per app. */
import postgres from 'postgres';

/** Map an app id (kebab-case) to a safe Postgres database name. */
export function appDbName(id: string): string {
  return `app_${id.replace(/[^a-z0-9_]/g, '_')}`;
}

/** Connection string injected into an app backend as DATABASE_URL. */
export function appDatabaseUrl(id: string): string {
  const host = process.env.PLATFORM_PG_HOST ?? 'localhost';
  const port = process.env.PLATFORM_PG_PORT ?? '5432';
  return `postgres://postgres@${host}:${port}/${appDbName(id)}`;
}

function adminUrl(): string {
  const url = process.env.PLATFORM_PG_ADMIN_URL;
  if (!url) {
    throw new Error('PLATFORM_PG_ADMIN_URL is not set');
  }
  return url;
}

/**
 * Ensure the app's database exists, creating it on first use.
 * Returns the connection string for the app backend.
 */
export async function ensureAppDatabase(id: string): Promise<string> {
  const name = appDbName(id);
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
  return appDatabaseUrl(id);
}

/** Drop an app's database (used when an app is deleted). Best-effort. */
export async function dropAppDatabase(id: string): Promise<void> {
  const name = appDbName(id);
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
