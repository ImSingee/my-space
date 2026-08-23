import { describe, expect, it, vi } from 'vitest';
import {
  appCompatibility,
  type AppCompatibility,
} from '../../app-compatibility';
import type { AppDetail, AppSummary } from '../../server/apps/inspect';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function appTool(platform: PlatformClient, name: string) {
  const found = createAppTools({ platform }).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name} tool.`);
  return found;
}

function appSummary(slug: string, compatibility: AppCompatibility): AppSummary {
  return {
    id: `${slug}-id`,
    slug,
    name: slug,
    description: null,
    status: 'deployed',
    currentVersion: 1,
    compatibility,
    capabilities: [],
    updatedAt: '2026-08-18T00:00:00.000Z',
  };
}

function appDetail(compatibility: AppCompatibility): AppDetail {
  return {
    id: 'demo-app',
    slug: 'demo-app',
    name: 'Demo App',
    description: null,
    status: 'deployed',
    backendMode: null,
    dbName: null,
    dataDbName: null,
    currentVersion: 1,
    currentDeploymentId: 'deployment-1',
    compatibility,
    currentSourceCommit: 'source-commit',
    capabilities: [],
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    manifest: null,
    ops: {
      backend: { capable: false, mode: null, running: false },
      cron: { enabled: false, jobs: [] },
      webhook: {
        enabled: false,
        url: null,
        hasSecret: false,
        auth: 'platform',
      },
      storage: { enabled: false },
      kv: { enabled: false, url: null, entryCount: 0 },
      dataTable: {
        enabled: false,
        url: null,
        dbName: null,
        schemaHash: null,
      },
    },
    deployments: [],
  };
}

describe('App compatibility Agent guidance', () => {
  it('points outdated list entries to the compatibility Skill', async () => {
    const listApps = vi
      .fn<PlatformClient['listApps']>()
      .mockResolvedValue([
        appSummary('outdated', appCompatibility(1)),
        appSummary('current', appCompatibility(2)),
      ]);
    const list = appTool(
      { listApps } as unknown as PlatformClient,
      'list_apps',
    );

    const result = toolText(await list.execute('list', {}));
    const [outdated, current] = result.split('\n');
    expect(outdated).toContain('read the `app-compatibility` Skill');
    expect(current).not.toContain('app-compatibility');
  });

  it('points outdated and unsupported details to the compatibility Skill', async () => {
    const getApp = vi
      .fn<PlatformClient['getApp']>()
      .mockResolvedValueOnce(appDetail(appCompatibility(1)))
      .mockResolvedValueOnce(appDetail(appCompatibility(2)))
      .mockResolvedValueOnce(appDetail(appCompatibility(0)));
    const get = appTool({ getApp } as unknown as PlatformClient, 'get_app');

    const outdated = toolText(
      await get.execute('outdated', { id: 'demo-app' }),
    );
    const current = toolText(await get.execute('current', { id: 'demo-app' }));
    const unsupported = toolText(
      await get.execute('unsupported', { id: 'demo-app' }),
    );

    expect(outdated).toContain('read the `app-compatibility` Skill');
    expect(current).not.toContain('app-compatibility');
    expect(unsupported).toMatch(
      /runtime disabled; read the `app-compatibility` Skill/,
    );
  });

  it('points older rollback results to the compatibility Skill', async () => {
    const rollbackApp = vi
      .fn<PlatformClient['rollbackApp']>()
      .mockResolvedValueOnce({
        version: 1,
        dataSchemaMismatch: false,
        compatibility: appCompatibility(1),
      })
      .mockResolvedValueOnce({
        version: 0,
        dataSchemaMismatch: false,
        compatibility: appCompatibility(0),
      });
    const rollback = appTool(
      { rollbackApp } as unknown as PlatformClient,
      'rollback_app',
    );

    const outdated = toolText(
      await rollback.execute('outdated', { id: 'demo-app', version: 1 }),
    );
    const unsupported = toolText(
      await rollback.execute('unsupported', { id: 'demo-app', version: 0 }),
    );

    expect(outdated).toContain('read the `app-compatibility` Skill');
    expect(unsupported).toContain('read the `app-compatibility` Skill');
  });
});
