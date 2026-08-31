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

describe('Workflow slug migration', () => {
  it('backfills slug from id without rewriting technical relations', async () => {
    const client = new PGlite();

    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const slugMigrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('ALTER TABLE "workflows" ADD COLUMN "slug" text'),
        ),
      );
      expect(slugMigrationIndex).toBeGreaterThanOrEqual(0);
      const slugMigration = migrations[slugMigrationIndex];

      for (const migration of migrations.slice(0, slugMigrationIndex)) {
        await applyStatements(client, migration.sql);
      }

      await client.query(
        `INSERT INTO workflows (id, name)
         VALUES ('legacy-daily-digest', 'Legacy daily digest')`,
      );
      await client.query(
        `INSERT INTO workflow_deployments
           (id, workflow_id, version, status)
         VALUES ('deployment-one', 'legacy-daily-digest', 1, 'deployed')`,
      );
      await client.query(
        `INSERT INTO workflow_runs
           (id, workflow_id, deployment_id, version, trigger, status)
         VALUES (
           'run-one',
           'legacy-daily-digest',
           'deployment-one',
           1,
           'manual',
           'succeeded'
         )`,
      );

      await applyStatements(client, slugMigration!.sql);

      const workflows = await client.query<{
        id: string;
        slug: string;
      }>('SELECT id, slug FROM workflows');
      expect(workflows.rows).toEqual([
        { id: 'legacy-daily-digest', slug: 'legacy-daily-digest' },
      ]);

      const relations = await client.query<{
        deployment_workflow_id: string;
        run_workflow_id: string;
      }>(
        `SELECT
           d.workflow_id AS deployment_workflow_id,
           r.workflow_id AS run_workflow_id
         FROM workflow_deployments d
         JOIN workflow_runs r ON r.deployment_id = d.id`,
      );
      expect(relations.rows).toEqual([
        {
          deployment_workflow_id: 'legacy-daily-digest',
          run_workflow_id: 'legacy-daily-digest',
        },
      ]);

      await expect(
        client.query(
          `INSERT INTO workflows (id, slug, name)
           VALUES ('another-id', 'legacy-daily-digest', 'Duplicate slug')`,
        ),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        client.query(
          `INSERT INTO workflows (id, slug, name)
           VALUES ('missing-slug', NULL, 'Missing slug')`,
        ),
      ).rejects.toThrow(/null value/);
    } finally {
      await client.close();
    }
  });
});
