import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDetailForAgent } from '~server/workflows/inspect';
import type { NormalizedWorkflowManifest } from '~server/workflows/manifest';
import type { PlatformClient } from '../platform-client';

const bundleWorktreeForDeploy = vi.hoisted(() =>
  vi.fn<() => Promise<{ bundleBase64: string; headCommit: string }>>(
    async () => ({ bundleBase64: 'bundle', headCommit: 'commit' }),
  ),
);

vi.mock('../local-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-sources')>()),
  bundleWorktreeForDeploy,
}));

const { createWorkflowTools } = await import('./workflows');

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

const unsupportedCompatibility = {
  version: 0,
  latestVersion: 1,
  minimumSupportedVersion: 1,
  isSupported: false,
  isLatest: false,
};

const newerCompatibility = {
  version: 2,
  latestVersion: 1,
  minimumSupportedVersion: 1,
  isSupported: false,
  isLatest: false,
};

const currentCompatibility = {
  version: 1,
  latestVersion: 1,
  minimumSupportedVersion: 1,
  isSupported: true,
  isLatest: true,
};

function manifest(): NormalizedWorkflowManifest {
  return {
    id: '01dailyid',
    name: 'Daily digest',
    description: '',
    entry: 'workflow.ts',
    network: [],
    triggers: {
      cron: [],
      webhook: { enabled: false, url: null },
    },
  };
}

function detail(): WorkflowDetailForAgent {
  return {
    id: '01dailyid',
    slug: 'daily-digest',
    createdAt: '2026-09-01T00:00:00.000Z',
    name: 'Daily digest',
    description: null,
    status: 'deployed',
    liveVersion: 1,
    compatibility: unsupportedCompatibility,
    inputSchema: null,
    network: { mode: 'blocked', destinations: [], legacy: false },
    webhook: { enabled: false, url: null },
    cron: [],
    recentRuns: [],
    deployments: [
      {
        version: 1,
        status: 'deployed',
        error: null,
        isCurrent: false,
        canRollback: true,
        compatibility: unsupportedCompatibility,
        message: 'Initial release',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };
}

function workflowTool(name: string, platform: PlatformClient) {
  const found = createWorkflowTools({
    platform,
    sessionId: 'session-one',
  }).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing ${name} tool.`);
  return found;
}

beforeEach(() => {
  bundleWorktreeForDeploy.mockClear();
});

describe('Agent Workflow compatibility contract', () => {
  it('surfaces unsupported live and deployment versions during inspection', async () => {
    const listWorkflows = vi
      .fn<PlatformClient['listWorkflows']>()
      .mockResolvedValue([
        {
          id: '01dailyid',
          slug: 'daily-digest',
          name: 'Daily digest',
          description: null,
          status: 'deployed',
          liveVersion: 1,
          compatibility: unsupportedCompatibility,
          webhook: false,
          cronCount: 0,
        },
      ]);
    const getWorkflow = vi
      .fn<PlatformClient['getWorkflow']>()
      .mockResolvedValue(detail());
    const platform = {
      listWorkflows,
      getWorkflow,
    } as unknown as PlatformClient;

    const listOutput = toolText(
      await workflowTool('list_workflows', platform).execute('list', {}),
    );
    const getOutput = toolText(
      await workflowTool('get_workflow', platform).execute('get', {
        id: '01dailyid',
      }),
    );

    expect(listOutput).toContain('compatibility v0');
    expect(listOutput).toContain('`workflow-compatibility` Skill');
    expect(getOutput).toContain('runtime disabled');
    expect(getOutput).toContain('deployed');
    expect(getOutput).toContain('[rollbackable]');
    expect(getOutput).toContain('Agent restore only; runtime disabled');
  });

  it('directs newer live deployments to a platform update', async () => {
    const newerDetail = {
      ...detail(),
      compatibility: newerCompatibility,
      deployments: [
        {
          ...detail().deployments[0],
          compatibility: newerCompatibility,
        },
      ],
    };
    const listWorkflows = vi
      .fn<PlatformClient['listWorkflows']>()
      .mockResolvedValue([
        {
          id: newerDetail.id,
          slug: newerDetail.slug,
          name: newerDetail.name,
          description: newerDetail.description,
          status: newerDetail.status,
          liveVersion: newerDetail.liveVersion,
          compatibility: newerCompatibility,
          webhook: false,
          cronCount: 0,
        },
      ]);
    const getWorkflow = vi
      .fn<PlatformClient['getWorkflow']>()
      .mockResolvedValue(newerDetail);
    const platform = {
      listWorkflows,
      getWorkflow,
    } as unknown as PlatformClient;

    const listOutput = toolText(
      await workflowTool('list_workflows', platform).execute('list', {}),
    );
    const getOutput = toolText(
      await workflowTool('get_workflow', platform).execute('get', {
        id: newerDetail.id,
      }),
    );

    expect(listOutput).toContain('update the platform');
    expect(getOutput).toContain('update the platform');
    expect(getOutput).not.toContain('Skill before updating and redeploying');
  });

  it('reports the manifest-selected compatibility version after deploy', async () => {
    const getWorkflow = vi
      .fn<PlatformClient['getWorkflow']>()
      .mockResolvedValue({
        ...detail(),
        compatibility: currentCompatibility,
      });
    const deployWorkflow = vi
      .fn<PlatformClient['deployWorkflow']>()
      .mockResolvedValue({
        deploymentId: 'deployment-two',
        version: 2,
        compatibilityVersion: 1,
        normalized: manifest(),
      });
    const deploy = workflowTool('deploy_workflow', {
      getWorkflow,
      deployWorkflow,
    } as unknown as PlatformClient);

    const output = toolText(
      await deploy.execute('deploy', {
        id: '01dailyid',
        source_path: 'workflows/daily-digest',
        message: 'Update digest',
      }),
    );

    expect(output).toContain('v2, compatibility v1');
    expect(deployWorkflow).toHaveBeenCalledWith(
      '01dailyid',
      expect.objectContaining({ generation: detail().createdAt }),
    );
  });

  it('warns after Agent restores an unsupported deployment', async () => {
    const rollbackWorkflow = vi
      .fn<PlatformClient['rollbackWorkflow']>()
      .mockResolvedValue({
        version: 1,
        compatibility: unsupportedCompatibility,
      });
    const rollback = workflowTool('rollback_workflow', {
      rollbackWorkflow,
    } as unknown as PlatformClient);

    const output = toolText(
      await rollback.execute('rollback', {
        id: '01dailyid',
        version: 1,
      }),
    );

    expect(output).toContain('below the platform minimum v1');
    expect(output).toContain('`workflow-compatibility` Skill');
    expect(output).toContain('cannot run until it is updated and redeployed');
  });

  it('directs newer restored deployments to a platform update', async () => {
    const rollbackWorkflow = vi
      .fn<PlatformClient['rollbackWorkflow']>()
      .mockResolvedValue({
        version: 3,
        compatibility: newerCompatibility,
      });
    const rollback = workflowTool('rollback_workflow', {
      rollbackWorkflow,
    } as unknown as PlatformClient);

    const output = toolText(
      await rollback.execute('rollback', {
        id: '01dailyid',
        version: 3,
      }),
    );

    expect(output).toContain("newer than this platform's latest supported v1");
    expect(output).toContain('cannot run until the platform is updated');
    expect(output).not.toContain('updated and redeployed');
  });
});
