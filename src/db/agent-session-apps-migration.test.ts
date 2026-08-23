import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

async function applyStatements(client: PGlite, statements: string[]) {
  for (const statement of statements) {
    await client.exec(statement);
  }
}

describe('Agent conversation App association migration', () => {
  it('drops the singular column without backfilling historical associations', async () => {
    const client = new PGlite();

    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const associationMigrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('CREATE TABLE "agent_session_apps"'),
        ),
      );
      expect(associationMigrationIndex).toBeGreaterThan(0);
      const associationMigration = migrations[associationMigrationIndex];
      expect(associationMigration).toBeDefined();

      for (const migration of migrations.slice(0, associationMigrationIndex)) {
        await applyStatements(client, migration.sql);
      }

      await client.query(
        `INSERT INTO apps (id, slug, name)
         VALUES ('legacy-app', 'legacy-app', 'Legacy App')`,
      );
      await client.query(
        `INSERT INTO agent_sessions (id, title, app_id)
         VALUES ('legacy-session', 'Legacy session', 'legacy-app')`,
      );

      await applyStatements(client, associationMigration!.sql);

      const legacyColumn = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'agent_sessions'
           AND column_name = 'app_id'`,
      );
      expect(legacyColumn.rows).toEqual([]);

      const associations = await client.query<{
        session_id: string;
        app_id: string;
      }>(
        `SELECT session_id, app_id
         FROM agent_session_apps`,
      );
      expect(associations.rows).toEqual([]);

      await client.query(
        `INSERT INTO agent_session_apps (session_id, app_id)
         VALUES ('legacy-session', 'legacy-app')`,
      );
      await expect(
        client.query(
          `INSERT INTO agent_session_apps (session_id, app_id)
           VALUES ('legacy-session', 'legacy-app')`,
        ),
      ).rejects.toThrow(/agent_session_apps_pkey/);

      await client.query(`DELETE FROM apps WHERE id = 'legacy-app'`);
      const afterCascade = await client.query(
        `SELECT session_id, app_id FROM agent_session_apps`,
      );
      expect(afterCascade.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
