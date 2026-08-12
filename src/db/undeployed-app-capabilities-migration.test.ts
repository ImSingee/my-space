import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';

const migrationUrl = new URL(
  '../../migrations/0004_clear_undeployed_app_capabilities.sql',
  import.meta.url,
);

const capabilities = {
  database: true,
  frontend: true,
  widgets: true,
  backend: true,
  cron: false,
  webhook: false,
  storage: false,
  kv: false,
  dataTable: true,
  userscripts: false,
};

// Applying the full migration history can exceed Vitest's per-test timeout
// when files initialize in parallel. Keep setup outside the timed test body.
const { db, schema } = await createTestDb();

afterAll(async () => {
  await db.$client.close();
});

describe('undeployed App capability migration', () => {
  it('clears only deployment metadata from Apps without a successful deployment', async () => {
    await db.insert(schema.apps).values([
      {
        id: 'draft-app',
        slug: 'draft-app',
        name: 'Draft App',
        description: 'Never deployed',
        status: 'draft',
        capabilities,
        manifest: { id: 'draft-app', capabilities },
        backendMode: 'serverless',
      },
      {
        id: 'pending-app',
        slug: 'pending-app',
        name: 'Pending App',
        description: 'Data migration outcome is pending',
        status: 'building',
        capabilities,
        manifest: { id: 'pending-app', capabilities },
        backendMode: 'long-running',
        dbName: 'app_pending_app',
        dbPasswordCiphertext: 'encrypted-app-password',
        dataDbName: 'data_pending_app',
        dataDbPasswordCiphertext: 'encrypted-data-password',
        dataSchemaHash: 'pending-schema-hash',
        dataActivationId: 'pending-deployment-id',
      },
      {
        id: 'live-app',
        slug: 'live-app',
        name: 'Live App',
        description: 'Successfully deployed',
        status: 'deployed',
        capabilities,
        manifest: { id: 'live-app', capabilities },
        backendMode: 'long-running',
        currentDeploymentId: 'live-deployment-id',
        dbName: 'app_live_app',
        dbPasswordCiphertext: 'encrypted-live-app-password',
        dataDbName: 'data_live_app',
        dataDbPasswordCiphertext: 'encrypted-live-data-password',
        dataSchemaHash: 'live-schema-hash',
      },
    ]);

    const before = new Map(
      (await db.query.apps.findMany()).map((app) => [app.id, app]),
    );
    const migrationSql = await readFile(migrationUrl, 'utf8');

    await db.$client.exec(migrationSql);

    const after = new Map(
      (await db.query.apps.findMany()).map((app) => [app.id, app]),
    );
    expect(after.get('draft-app')).toEqual({
      ...before.get('draft-app'),
      capabilities: null,
      manifest: null,
      backendMode: null,
    });
    expect(after.get('pending-app')).toEqual({
      ...before.get('pending-app'),
      capabilities: null,
      manifest: null,
      backendMode: null,
    });
    expect(after.get('pending-app')).toMatchObject({
      dbName: 'app_pending_app',
      dbPasswordCiphertext: 'encrypted-app-password',
      dataDbName: 'data_pending_app',
      dataDbPasswordCiphertext: 'encrypted-data-password',
      dataSchemaHash: 'pending-schema-hash',
      dataActivationId: 'pending-deployment-id',
    });
    expect(after.get('live-app')).toEqual(before.get('live-app'));
  });
});
