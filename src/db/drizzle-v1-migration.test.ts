import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

// Exact timestamps from the final v2 journal before `drizzle-kit up` converted
// the migration layout. Drizzle v1 must match these rows to the v3 folders
// without replaying already-applied SQL.
const legacyCreatedAt = [
  1782317641722, 1783792243078, 1784916003681, 1784922017293, 1786627920961,
  1786635620376, 1786702438403, 1786998478091, 1787510338181,
];

async function applyMigrationSql(client: PGlite) {
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    for (const statement of migration.sql) {
      if (statement.trim()) await client.exec(statement);
    }
  }
}

describe('Drizzle v1 platform migrations', () => {
  it('applies the v3 migration folders from scratch and is idempotent', async () => {
    const client = new PGlite();
    const database = drizzle({ client });

    try {
      await migrate(database, { migrationsFolder });
      await migrate(database, { migrationsFolder });

      const accounts = await client.query<{
        column_default: string | null;
        is_nullable: string;
      }>(
        `SELECT is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'account'
           AND column_name = 'issuer'`,
      );
      expect(accounts.rows).toEqual([
        { is_nullable: 'NO', column_default: null },
      ]);

      const ledger = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM drizzle.__drizzle_migrations`,
      );
      expect(ledger.rows).toEqual([{ count: legacyCreatedAt.length }]);
    } finally {
      await client.close();
    }
  });

  it('upgrades a v2 ledger without replaying applied migrations', async () => {
    const client = new PGlite();
    const migrations = readMigrationFiles({ migrationsFolder });

    try {
      expect(migrations).toHaveLength(legacyCreatedAt.length);
      await applyMigrationSql(client);
      await client.exec(
        `CREATE SCHEMA drizzle;
         CREATE TABLE drizzle.__drizzle_migrations (
           id serial PRIMARY KEY,
           hash text NOT NULL,
           created_at bigint
         );`,
      );
      for (const [index, migration] of migrations.entries()) {
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [migration.hash, legacyCreatedAt[index]],
        );
      }

      const database = drizzle({ client });
      await migrate(database, { migrationsFolder });
      await migrate(database, { migrationsFolder });

      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'drizzle'
           AND table_name = '__drizzle_migrations'
         ORDER BY ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'id',
        'hash',
        'created_at',
        'name',
        'applied_at',
      ]);

      const ledger = await client.query<{
        applied_at: Date | null;
        name: string | null;
      }>(
        `SELECT name, applied_at
         FROM drizzle.__drizzle_migrations
         ORDER BY id`,
      );
      expect(ledger.rows.map((row) => row.name)).toEqual(
        migrations.map((migration) => migration.name),
      );
      expect(ledger.rows.every((row) => row.applied_at === null)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
