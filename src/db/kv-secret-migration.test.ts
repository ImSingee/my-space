import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

type LegacyKvRow = {
  id: string;
  app_id: string;
  key: string;
  value: string;
  secret: boolean;
  created_at: Date;
  updated_at: Date;
};

type MigratedKvRow = LegacyKvRow & {
  value_ciphertext: string | null;
};

async function applyStatements(client: PGlite, statements: string[]) {
  for (const statement of statements) {
    await client.exec(statement);
  }
}

describe('KV secret storage migration', () => {
  it('preserves legacy plaintext rows and enforces the new storage states', async () => {
    const client = new PGlite();

    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const legacyMigrations = migrations.slice(0, 4);
      const kvSecretMigration = migrations[4];

      expect(kvSecretMigration).toBeDefined();

      for (const migration of legacyMigrations) {
        await applyStatements(client, migration.sql);
      }

      await client.query(
        `INSERT INTO apps (id, slug, name)
         VALUES ('app-1', 'app-1', 'App 1')`,
      );
      await client.query(
        `INSERT INTO app_kv
           (id, app_id, key, value, secret, created_at, updated_at)
         VALUES
           (
             'plain-id',
             'app-1',
             'plain-key',
             'plain-value',
             false,
             '2026-01-02T03:04:05Z',
             '2026-01-03T04:05:06Z'
           ),
           (
             'secret-id',
             'app-1',
             'secret-key',
             'legacy-secret-value',
             true,
             '2026-02-03T04:05:06Z',
             '2026-02-04T05:06:07Z'
           )`,
      );

      const before = await client.query<LegacyKvRow>(
        `SELECT id, app_id, key, value, secret, created_at, updated_at
         FROM app_kv
         ORDER BY id`,
      );

      await applyStatements(client, kvSecretMigration!.sql);

      const after = await client.query<MigratedKvRow>(
        `SELECT
           id,
           app_id,
           key,
           value,
           value_ciphertext,
           secret,
           created_at,
           updated_at
         FROM app_kv
         ORDER BY id`,
      );

      expect(
        after.rows.map(({ value_ciphertext: _ciphertext, ...row }) => row),
      ).toEqual(before.rows);
      expect(after.rows.map((row) => row.value_ciphertext)).toEqual([
        null,
        null,
      ]);

      await client.query(
        `INSERT INTO app_kv
           (id, app_id, key, value, value_ciphertext, secret)
         VALUES
           (
             'encrypted-id',
             'app-1',
             'encrypted-key',
             NULL,
             'v1.iv.ciphertext.tag',
             true
           )`,
      );

      const encrypted = await client.query<{
        value: string | null;
        value_ciphertext: string | null;
        secret: boolean;
      }>(
        `SELECT value, value_ciphertext, secret
         FROM app_kv
         WHERE id = 'encrypted-id'`,
      );
      expect(encrypted.rows).toEqual([
        {
          value: null,
          value_ciphertext: 'v1.iv.ciphertext.tag',
          secret: true,
        },
      ]);

      const invalidStates = [
        { value: null, ciphertext: null, secret: true },
        { value: 'plaintext', ciphertext: 'ciphertext', secret: true },
        { value: null, ciphertext: null, secret: false },
        { value: null, ciphertext: 'ciphertext', secret: false },
        { value: 'plaintext', ciphertext: 'ciphertext', secret: false },
      ];

      for (const [index, state] of invalidStates.entries()) {
        await expect(
          client.query(
            `INSERT INTO app_kv
               (id, app_id, key, value, value_ciphertext, secret)
             VALUES ($1, 'app-1', $2, $3, $4, $5)`,
            [
              `invalid-${index}`,
              `invalid-${index}`,
              state.value,
              state.ciphertext,
              state.secret,
            ],
          ),
        ).rejects.toThrow(/app_kv_value_storage_check/);
      }
    } finally {
      await client.close();
    }
  });
});
