import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetail } from '~server/apps/inspect';
import type { NormalizedManifest } from '~server/apps/manifest';
import type { AppDeployResponse, PlatformClient } from '../platform-client';

const bundleWorktreeForDeploy = vi.hoisted(() =>
  vi.fn<() => Promise<{ bundleBase64: string; headCommit: string }>>(
    async () => ({
      bundleBase64: 'bundle',
      headCommit: 'commit',
    }),
  ),
);

vi.mock('../local-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-sources')>()),
  bundleWorktreeForDeploy,
}));

const { createAppTools } = await import('./apps');

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function manifest(frontend: boolean): NormalizedManifest {
  return {
    id: 'immutable-app-id',
    name: 'Example App',
    description: '',
    version: 1,
    capabilities: {
      database: false,
      frontend,
      widgets: false,
      backend: false,
      cron: false,
      webhook: false,
      storage: false,
      kv: false,
      dataTable: false,
    },
    backendMode: 'serverless',
    ...(frontend
      ? {
          app: {
            url: '/app/human-slug',
            routes: [],
          },
        }
      : {}),
    widgets: [],
    cron: [],
  };
}

function appDetail(frontend: boolean): AppDetail {
  return {
    id: 'immutable-app-id',
    slug: 'human-slug',
    name: 'Example App',
    description: null,
    status: 'deployed',
    backendMode: null,
    dbName: null,
    dataDbName: null,
    currentVersion: 1,
    currentDeploymentId: 'deployment-one',
    compatibility: null,
    currentSourceCommit: 'commit',
    capabilities: frontend ? ['frontend'] : [],
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    manifest: manifest(frontend),
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

function deployResponse(frontend: boolean): AppDeployResponse {
  return {
    deploymentId: 'deployment-two',
    version: 2,
    compatibilityVersion: 2,
    slug: 'human-slug',
    normalized: manifest(frontend),
  };
}

function appTool(name: 'get_app' | 'deploy_app', platform: PlatformClient) {
  const found = createAppTools({
    platform,
    sessionId: 'session-one',
  }).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name} tool.`);
  return found;
}

beforeEach(() => {
  bundleWorktreeForDeploy.mockClear();
});

describe('Agent App lifecycle URLs', () => {
  it('reports the user-facing URL when inspecting a frontend App', async () => {
    const getApp = vi
      .fn<PlatformClient['getApp']>()
      .mockResolvedValue(appDetail(true));
    const get = appTool('get_app', { getApp } as unknown as PlatformClient);

    const output = toolText(await get.execute('get', { id: 'human-slug' }));

    expect(output).toContain('App URL: /app/human-slug');
    expect(output).not.toContain('/embed');
  });

  it('reports the user-facing URL after deploying a frontend App', async () => {
    const getApp = vi
      .fn<PlatformClient['getApp']>()
      .mockResolvedValue(appDetail(true));
    const associateSessionApp = vi
      .fn<PlatformClient['associateSessionApp']>()
      .mockResolvedValue({ appId: 'immutable-app-id' });
    const deployApp = vi
      .fn<PlatformClient['deployApp']>()
      .mockResolvedValue(deployResponse(true));
    const deploy = appTool('deploy_app', {
      getApp,
      associateSessionApp,
      deployApp,
    } as unknown as PlatformClient);

    const output = toolText(
      await deploy.execute('deploy', {
        id: 'human-slug',
        source_path: 'apps/human-slug',
        message: 'Update the App',
      }),
    );

    expect(output).toContain('App URL: /app/human-slug');
    expect(output).not.toContain('/embed');
    expect(output).not.toContain('App (iframe)');
  });

  it('omits an App URL when no frontend is deployed', async () => {
    const getApp = vi
      .fn<PlatformClient['getApp']>()
      .mockResolvedValue(appDetail(false));
    const get = appTool('get_app', { getApp } as unknown as PlatformClient);

    const output = toolText(await get.execute('get', { id: 'human-slug' }));

    expect(output).not.toContain('App URL:');
  });
});
