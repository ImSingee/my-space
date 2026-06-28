import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Arbitrary, app-wide constant key for the migration advisory lock ("MIGR").
const MIGRATION_LOCK_KEY = 0x4d494752;

export async function runMigrations() {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) {
    throw new Error('environment variable DATABASE_URL is not set');
  }

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
      await migrate(db, { migrationsFolder: './migrations' });
      console.log('Database migrations completed successfully');
    } finally {
      await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await migrationClient.end();
  }
}
