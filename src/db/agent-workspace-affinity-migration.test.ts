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

describe('Agent workspace affinity migration', () => {
  it('backfills only the latest runner proven by a Runner-originated event', async () => {
    const client = new PGlite();

    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const legacyMigrations = migrations.slice(0, 5);
      const affinityMigration = migrations[5];
      expect(affinityMigration).toBeDefined();

      for (const migration of legacyMigrations) {
        await applyStatements(client, migration.sql);
      }

      await client.query(
        `INSERT INTO agent_sessions (id, title)
         VALUES
           ('session-proven', 'Proven'),
           ('session-unaccepted', 'Unaccepted'),
           ('session-uninitialized', 'Uninitialized')`,
      );
      await client.query(
        `INSERT INTO agent_runs
           (id, session_id, provider_id, model_id, status, input, runner_id, created_at)
         VALUES
           (
             'run-proven-old',
             'session-proven',
             'provider',
             'model',
             'completed',
             '{}',
             'runner-old',
             '2026-01-01T00:00:00Z'
           ),
           (
             'run-proven-current',
             'session-proven',
             'provider',
             'model',
             'completed',
             '{}',
             'runner-current',
             '2026-01-02T00:00:00Z'
           ),
           (
             'run-unaccepted-newer',
             'session-proven',
             'provider',
             'model',
             'failed',
             '{}',
             'runner-never-accepted',
             '2026-01-03T00:00:00Z'
           ),
           (
             'run-unaccepted-only',
             'session-unaccepted',
             'provider',
             'model',
             'failed',
             '{}',
             'runner-ghost',
             '2026-01-04T00:00:00Z'
           )`,
      );
      await client.query(
        `INSERT INTO agent_run_events
           (id, run_id, seq, runner_seq, type, payload)
         VALUES
           (
             'event-proven-old',
             'run-proven-old',
             1,
             1,
             'assistant_start',
             '{"type":"assistant_start"}'
           ),
           (
             'event-proven-current',
             'run-proven-current',
             1,
             1,
             'assistant_start',
             '{"type":"assistant_start"}'
           ),
           (
             'event-platform-failure-newer',
             'run-unaccepted-newer',
             1,
             NULL,
             'error',
             '{"type":"error","message":"Dispatch failed"}'
           ),
           (
             'event-platform-failure-only',
             'run-unaccepted-only',
             1,
             NULL,
             'error',
             '{"type":"error","message":"Dispatch failed"}'
           )`,
      );

      await applyStatements(client, affinityMigration!.sql);

      const result = await client.query<{
        id: string;
        workspace_affinity_state: string;
        workspace_runner_id: string | null;
      }>(
        `SELECT id, workspace_affinity_state, workspace_runner_id
         FROM agent_sessions
         ORDER BY id`,
      );
      expect(result.rows).toEqual([
        {
          id: 'session-proven',
          workspace_affinity_state: 'claimed',
          workspace_runner_id: 'runner-current',
        },
        {
          id: 'session-unaccepted',
          workspace_affinity_state: 'uninitialized',
          workspace_runner_id: null,
        },
        {
          id: 'session-uninitialized',
          workspace_affinity_state: 'uninitialized',
          workspace_runner_id: null,
        },
      ]);

      await expect(
        client.query(
          `UPDATE agent_sessions
           SET workspace_runner_id = 'runner-without-claim'
           WHERE id = 'session-uninitialized'`,
        ),
      ).rejects.toThrow(/agent_sessions_workspace_affinity_check/);
    } finally {
      await client.close();
    }
  });
});
