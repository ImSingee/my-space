/**
 * Test-only: an in-memory PGlite database with the real SQL migrations
 * applied — the same DDL production runs, not a parallel schema definition.
 *
 * Intended use is mocking the `~/db` module so DB-touching logic can be
 * unit-tested hermetically (no external Postgres):
 *
 *   vi.mock('~/db', async () => {
 *     const { createTestDb } = await import('~/db/test-db');
 *     return createTestDb();
 *   });
 */
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema';

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: 'snake_case' });
  await migrate(db, {
    migrationsFolder: path.resolve(import.meta.dirname, '../../migrations'),
  });
  return { db, schema };
}
