import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Arbitrary, app-wide constant key for the migration advisory lock ("MIGR").
const MIGRATION_LOCK_KEY = 0x4d494752;

/**
 * Resolve the SQL migrations directory to an absolute path. The built server is
 * shipped alongside a `migrations/` folder at its working directory (the Docker
 * image copies it, and `node .output/server/index.mjs` runs from the repo root),
 * but the bundle itself doesn't contain it — so resolve from cwd and fail with a
 * clear, actionable error rather than a cryptic ENOENT if it can't be found.
 * `HATCH_MIGRATIONS_DIR` overrides the location for non-standard layouts.
 */
function resolveMigrationsFolder(): string {
  const folder = resolve(process.env.HATCH_MIGRATIONS_DIR ?? './migrations');
  if (!existsSync(resolve(folder, 'meta/_journal.json'))) {
    throw new Error(
      `Database migrations folder not found at "${folder}". Ensure the ` +
        '`migrations/` directory is present in the server working directory, ' +
        'or set HATCH_MIGRATIONS_DIR to its absolute path.',
    );
  }
  return folder;
}

export async function runMigrations() {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    throw new Error('environment variable DATABASE_URL is not set');
  }

  const migrationsFolder = resolveMigrationsFolder();

  // Use a separate connection for migrations with max: 1
  const migrationClient = postgres(DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  console.log('Running database migrations...');

  try {
    // Serialize migrations across instances: when several servers boot at once
    // they would otherwise read the same "last applied" migration and run the
    // same DDL concurrently, and the losers crash on duplicate table/column
    // errors. The session-level lock (on this max:1 connection) makes the
    // others wait, then re-check and no-op.
    await migrationClient`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(db, { migrationsFolder });
      console.log('Database migrations completed successfully');
    } finally {
      await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await migrationClient.end();
  }
}
