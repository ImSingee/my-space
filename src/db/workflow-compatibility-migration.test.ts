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

describe('Workflow compatibility migration', () => {
  it('backfills existing deployments as v1 and removes the default', async () => {
    const client = new PGlite();

    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const compatibilityMigrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes(
            'ADD COLUMN "compatibility_version" integer DEFAULT 1 NOT NULL',
          ),
        ),
      );
      expect(compatibilityMigrationIndex).toBeGreaterThanOrEqual(0);
      const compatibilityMigration = migrations[compatibilityMigrationIndex];

      for (const migration of migrations.slice(
        0,
        compatibilityMigrationIndex,
      )) {
        await applyStatements(client, migration.sql);
      }

      await client.query(
        `INSERT INTO workflows (id, slug, name)
         VALUES ('legacy-workflow', 'legacy-workflow', 'Legacy workflow')`,
      );
      await client.query(
        `INSERT INTO workflow_deployments
           (id, workflow_id, version, status)
         VALUES ('legacy-deployment', 'legacy-workflow', 1, 'deployed')`,
      );

      await applyStatements(client, compatibilityMigration!.sql);

      const deployments = await client.query<{
        compatibility_version: number;
      }>(
        `SELECT compatibility_version
         FROM workflow_deployments
         WHERE id = 'legacy-deployment'`,
      );
      expect(deployments.rows).toEqual([{ compatibility_version: 1 }]);

      await expect(
        client.query(
          `INSERT INTO workflow_deployments
             (id, workflow_id, version, status)
           VALUES ('missing-compatibility', 'legacy-workflow', 2, 'deployed')`,
        ),
      ).rejects.toThrow(/null value/);
    } finally {
      await client.close();
    }
  });
});
