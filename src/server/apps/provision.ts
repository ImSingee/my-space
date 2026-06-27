/** Server-only: provision a dedicated Postgres database per app. */
import postgres from 'postgres';

/** Map an app id (kebab-case) to a safe Postgres database name. */
export function appDbName(id: string): string {
  return `app_${id.replace(/[^a-z0-9_]/g, '_')}`;
}

/** Admin connection used to create/drop and derive per-app databases. */
function adminUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    throw new Error('APP_DATABASE_URL is not set');
  }
  return url;
}

/**
 * Connection string injected into an app backend as DATABASE_URL. Host, port
 * and credentials are inferred from APP_DATABASE_URL; only the database name is
 * swapped for the app's dedicated database.
 */
export function appDatabaseUrl(id: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${appDbName(id)}`;
  return url.toString();
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
