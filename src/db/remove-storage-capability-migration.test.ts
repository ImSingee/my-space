import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

type AppRow = {
  id: string;
  capabilities: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
};

type DeploymentRow = {
  id: string;
  manifest_normalized: Record<string, unknown> | null;
};

describe('remove Storage capability migration', () => {
  it('scrubs current and rollback JSON while preserving unrelated fields', async () => {
    const client = new PGlite();
    try {
      await client.exec(`
        CREATE TABLE apps (
          id text PRIMARY KEY,
          capabilities jsonb,
          manifest jsonb
        );
        CREATE TABLE deployments (
          id text PRIMARY KEY,
          manifest_normalized jsonb
        );
        INSERT INTO apps (id, capabilities, manifest) VALUES
          (
            'current',
            '{"backend":true,"storage":true,"kv":true}',
            '{"name":"Current","capabilities":{"backend":true,"storage":true},"storage":{"url":"/old"}}'
          ),
          ('empty', NULL, NULL);
        INSERT INTO deployments (id, manifest_normalized) VALUES
          (
            'rollback',
            '{"name":"Rollback","capabilities":{"backend":true,"storage":true},"storage":{"url":"/old"},"kv":{"url":"/kv"}}'
          ),
          ('empty', NULL);
      `);

      const sql = await readFile(
        path.resolve(
          import.meta.dirname,
          '../../migrations/0002_remove_storage_capability.sql',
        ),
        'utf8',
      );
      await client.exec(sql);

      const apps = await client.query<AppRow>(
        'SELECT id, capabilities, manifest FROM apps ORDER BY id',
      );
      expect(apps.rows).toEqual([
        {
          id: 'current',
          capabilities: { backend: true, kv: true },
          manifest: {
            name: 'Current',
            capabilities: { backend: true },
          },
        },
        { id: 'empty', capabilities: null, manifest: null },
      ]);

      const deployments = await client.query<DeploymentRow>(
        'SELECT id, manifest_normalized FROM deployments ORDER BY id',
      );
      expect(deployments.rows).toEqual([
        { id: 'empty', manifest_normalized: null },
        {
          id: 'rollback',
          manifest_normalized: {
            name: 'Rollback',
            capabilities: { backend: true },
            kv: { url: '/kv' },
          },
        },
      ]);
    } finally {
      await client.close();
    }
  });
});
