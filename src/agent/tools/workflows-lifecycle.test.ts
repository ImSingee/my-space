import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDetailForAgent } from '~server/workflows/inspect';
import type { PlatformClient } from '../platform-client';
import { createWorkflowTools } from './workflows';

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function workflowTool(name: string, platform: PlatformClient) {
  const found = createWorkflowTools({ platform }).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing ${name} tool.`);
  return found;
}

describe('Agent Workflow identity contract', () => {
  it('formats list_workflows like list_apps and preserves structured identity', async () => {
    const workflows = [
      {
        id: '01dailyid',
        slug: 'daily-digest',
        name: 'Daily digest',
        description: null,
        status: 'deployed' as const,
        liveVersion: 3,
        webhook: true,
        cronCount: 2,
      },
      {
        id: '01cronid',
        slug: 'cron-only',
        name: 'Cron only',
        description: null,
        status: 'deployed' as const,
        liveVersion: 1,
        webhook: false,
        cronCount: 1,
      },
      {
        id: '01hookid',
        slug: 'hook-only',
        name: 'Hook only',
        description: null,
        status: 'deployed' as const,
        liveVersion: 4,
        webhook: true,
        cronCount: 0,
      },
      {
        id: '01plainid',
        slug: 'plain-run',
        name: 'Plain run',
        description: null,
        status: 'deployed' as const,
        liveVersion: 2,
        webhook: false,
        cronCount: 0,
      },
      {
        id: '01draftid',
        slug: 'draft-flow',
        name: 'Draft flow',
        description: null,
        status: 'draft' as const,
        liveVersion: null,
        webhook: false,
        cronCount: 0,
      },
    ];
    const listWorkflows = vi
      .fn<PlatformClient['listWorkflows']>()
      .mockResolvedValue(workflows);
    const list = workflowTool('list_workflows', {
      listWorkflows,
    } as unknown as PlatformClient);

    const result = await list.execute('list', {});

    expect(toolText(result)).toBe(
      [
        '- Daily digest (id: 01dailyid, slug: daily-digest) [deployed] v3 — 2 cron, webhook',
        '- Cron only (id: 01cronid, slug: cron-only) [deployed] v1 — 1 cron',
        '- Hook only (id: 01hookid, slug: hook-only) [deployed] v4 — webhook',
        '- Plain run (id: 01plainid, slug: plain-run) [deployed] v2',
        '- Draft flow (id: 01draftid, slug: draft-flow) [draft] (not deployed)',
      ].join('\n'),
    );
    expect(result.details).toEqual({ workflows });
  });

  it('keeps the empty list response stable', async () => {
    const listWorkflows = vi
      .fn<PlatformClient['listWorkflows']>()
      .mockResolvedValue([]);
    const list = workflowTool('list_workflows', {
      listWorkflows,
    } as unknown as PlatformClient);

    const result = await list.execute('list', {});

    expect(toolText(result)).toBe('No workflows exist yet.');
    expect(result.details).toEqual({ workflows: [] });
  });

  it('looks up an existing Workflow by id and reports its slug URL', async () => {
    const detail: WorkflowDetailForAgent = {
      id: '01immutableid',
      slug: 'human-slug',
      createdAt: '2026-09-01T00:00:00.000Z',
      name: 'Example Workflow',
      description: null,
      status: 'draft',
      liveVersion: null,
      inputSchema: null,
      network: null,
      webhook: { enabled: false, url: null },
      cron: [],
      recentRuns: [],
      deployments: [],
    };
    const getWorkflow = vi
      .fn<PlatformClient['getWorkflow']>()
      .mockResolvedValue(detail);
    const get = workflowTool('get_workflow', {
      getWorkflow,
    } as unknown as PlatformClient);

    const result = await get.execute('get', { id: '01immutableid' });

    expect(getWorkflow).toHaveBeenCalledWith('01immutableid');
    expect(toolText(result)).toContain(
      'Example Workflow (id: 01immutableid, slug: human-slug)',
    );
    expect(toolText(result)).toContain('Workflow URL: /workflow/human-slug');
  });

  it('exposes slug on create and clone/source_path on checkout', () => {
    const tools = createWorkflowTools({
      platform: {} as PlatformClient,
    });
    const create = tools.find(
      (candidate) => candidate.name === 'create_workflow',
    );
    const checkout = tools.find(
      (candidate) => candidate.name === 'checkout_workflow',
    );
    if (!create || !checkout) throw new Error('Missing Workflow tools.');

    expect(create.parameters).toMatchObject({
      required: ['slug', 'name'],
      properties: {
        slug: expect.any(Object),
        target_path: expect.any(Object),
      },
    });
    expect(
      (create.parameters as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty('id');
    expect(checkout.parameters).toMatchObject({
      required: ['id', 'clone'],
      properties: {
        id: expect.any(Object),
        clone: expect.any(Object),
        source_path: expect.any(Object),
        force: expect.any(Object),
      },
    });
    expect(
      (checkout.parameters as { properties: Record<string, unknown> })
        .properties,
    ).not.toHaveProperty('target_path');
  });
});
