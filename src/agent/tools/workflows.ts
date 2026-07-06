/**
 * Workflow lifecycle tools: list, inspect, checkout, create, deploy, rollback.
 * Mirrors the app tools: platform state via PlatformClient, source in
 * runner-local worktrees fed by git bundles.
 */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  assertWorktreeAvailable,
  bundleWorktreeForDeploy,
  initNewWorktree,
  syncCheckoutFromBundle,
} from '../local-sources';
import type { PlatformClient } from '../platform-client';
import { writeScaffoldFiles } from '../scaffold-files';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

export function createWorkflowTools(options: {
  sessionId?: string;
  platform: PlatformClient;
}): AgentTool[] {
  const { platform } = options;

  const listWorkflowsTool = tool({
    name: 'list_workflows',
    label: 'List workflows',
    description:
      'List every workflow on the platform with its status, live version, and ' +
      'triggers. Use this to discover existing workflows before get_workflow ' +
      'or checkout_workflow.',
    parameters: Type.Object({}),
    execute: async () => {
      const workflows = await platform.listWorkflows();
      if (workflows.length === 0) {
        return text('No workflows exist yet.', { workflows });
      }
      const lines = workflows.map((w) => {
        const version =
          w.liveVersion != null ? ` v${w.liveVersion}` : ' (not deployed)';
        const triggers = [
          w.cronCount > 0 ? `${w.cronCount} cron` : null,
          w.webhook ? 'webhook' : null,
        ]
          .filter(Boolean)
          .join(', ');
        return `- ${w.id} · ${w.name} [${w.status}]${version}${
          triggers ? ` — ${triggers}` : ''
        }`;
      });
      return text(lines.join('\n'), { workflows });
    },
  });

  const getWorkflowTool = tool({
    name: 'get_workflow',
    label: 'Get workflow details',
    description:
      "Get one workflow's details: status, live version, input JSON Schema, " +
      'triggers (cron + webhook), recent runs, and deployment history. ' +
      'Mirrors the workflow management panel.',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to inspect.' }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const detail = await platform.getWorkflow(params.id);
      if (!detail) throw new Error(`Workflow "${params.id}" not found.`);
      const lines: (string | null)[] = [
        `${detail.name} (${detail.id}) — ${detail.status}` +
          (detail.liveVersion != null
            ? ` · v${detail.liveVersion}`
            : ' · not deployed'),
        detail.description ? `Description: ${detail.description}` : null,
        detail.webhook.enabled
          ? `Webhook: ${detail.webhook.url ?? 'n/a'} [secret set]`
          : null,
        detail.cron.length > 0
          ? `Cron: ${detail.cron
              .map((j) => `${j.name} [${j.schedule}]`)
              .join(', ')}`
          : null,
        `Input schema: ${JSON.stringify(detail.inputSchema)}`,
        '',
        'Recent runs:',
        ...(detail.recentRuns.length > 0
          ? detail.recentRuns.map(
              (r) => `  ${r.status} · ${r.trigger} · ${r.createdAt}`,
            )
          : ['  (none yet)']),
        '',
        'Deployments (newest first):',
        ...detail.deployments
          .slice(0, 10)
          .map((d) => `  v${d.version} · ${d.message ?? ''} · ${d.createdAt}`),
      ];
      return text(lines.filter((l) => l !== null).join('\n'), detail);
    },
  });

  const checkoutWorkflowTool = tool({
    name: 'checkout_workflow',
    label: 'Checkout workflow',
    description:
      "Checkout a workflow's Git repo into this chat's persistent worktree. " +
      'Use before reading or editing an existing workflow.',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to checkout.' }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      const source = await platform.getWorkflowSource(params.id);
      const checkout = await syncCheckoutFromBundle(
        sessionId,
        'workflow',
        source,
      );
      const lines = [
        `Checked out "${params.id}" at ${checkout.path}/.`,
        checkout.headCommit
          ? `HEAD: ${checkout.headCommit}`
          : 'No commits yet. Create files, then run git add and git commit.',
        checkout.remoteCommit
          ? `Remote master: ${checkout.remoteCommit}`
          : 'Remote master has no commits yet.',
        checkout.dirty
          ? `Worktree has local changes:\n${checkout.status}`
          : 'Worktree is clean.',
      ];
      return text(lines.join('\n'), checkout);
    },
  });

  const createWorkflowTool = tool({
    name: 'create_workflow',
    label: 'Create workflow',
    description:
      "Scaffold a new workflow from the platform template in this chat's " +
      'worktree (manifest, a `workflow.ts` defining a zod input + steps, and ' +
      'the @hatch/workflow SDK). Workflows run periodic/repetitive tasks; they ' +
      'have no custom UI/API, only manual/cron/webhook triggers.',
    parameters: Type.Object({
      id: Type.String({
        description: 'kebab-case id, e.g. "digest" or "sync-stars".',
      }),
      name: Type.String({ description: 'Human-readable name.' }),
      description: Type.Optional(
        Type.String({ description: 'One-line description.' }),
      ),
      pin: Type.Optional(
        Type.Boolean({
          description:
            'Pin the workflow to the sidebar (default true) so it is reachable ' +
            'right away.',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      // The workflow id doubles as the local directory name; reserve it
      // BEFORE the platform registers the id, or a collision here would
      // strand an empty draft workflow on the platform.
      await assertWorktreeAvailable(sessionId, params.id);
      const res = await platform.createWorkflow(params);
      await initNewWorktree(sessionId, 'workflow', res.id, (root) =>
        writeScaffoldFiles(root, res.files),
      );
      return text(
        `Created workflow "${res.id}". Source is at ${res.id}/.\n` +
          'Read the scaffolded files, edit workflow.ts (input schema + steps) ' +
          'and manifest.json (triggers), commit with git, then call ' +
          'deploy_workflow. Do not edit hatch/ (the platform SDK).',
        { id: res.id, name: res.name },
      );
    },
  });

  const deployWorkflowTool = tool({
    name: 'deploy_workflow',
    label: 'Deploy workflow',
    description:
      'Bundle the workflow into a single Deno program, capture its input JSON ' +
      'Schema, and deploy it so it can be triggered. Reports the version and ' +
      'webhook URL (if enabled).',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to deploy.' }),
      message: Type.String({
        description:
          'Required release note describing what this deployment changes ' +
          '(shown in the deployment history).',
      }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      const { bundleBase64 } = await bundleWorktreeForDeploy(
        sessionId,
        'workflow',
        params.id,
      );
      const res = await platform.deployWorkflow(params.id, {
        message: params.message,
        bundleBase64,
      });
      const lines = [
        `Deployed "${params.id}" (v${res.version}).`,
        res.normalized.triggers.webhook.enabled
          ? `Webhook: ${res.normalized.triggers.webhook.url}`
          : null,
        res.normalized.triggers.cron.length > 0
          ? `Cron: ${res.normalized.triggers.cron
              .map((j) => `${j.name} [${j.schedule}]`)
              .join(', ')}`
          : null,
      ].filter(Boolean);
      return text(lines.join('\n'), res);
    },
  });

  const rollbackWorkflowTool = tool({
    name: 'rollback_workflow',
    label: 'Rollback workflow',
    description:
      'Roll a workflow back to a previous deployment version, restoring that ' +
      "version's bundled program and source.",
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to roll back.' }),
      version: Type.Number({ description: 'Deployment version to restore.' }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const res = await platform.rollbackWorkflow(params.id, params.version);
      return text(`Rolled "${params.id}" back to v${res.version}.`, res);
    },
  });

  return [
    listWorkflowsTool,
    getWorkflowTool,
    checkoutWorkflowTool,
    createWorkflowTool,
    deployWorkflowTool,
    rollbackWorkflowTool,
  ];
}
