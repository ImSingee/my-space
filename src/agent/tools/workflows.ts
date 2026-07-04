/** Workflow lifecycle tools: list, inspect, checkout, create, deploy, rollback. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

export function createWorkflowTools(options: {
  sessionId?: string;
}): AgentTool[] {
  const listWorkflowsTool = tool({
    name: 'list_workflows',
    label: 'List workflows',
    description:
      'List every workflow on the platform with its status, live version, and ' +
      'triggers. Use this to discover existing workflows before get_workflow ' +
      'or checkout_workflow.',
    parameters: Type.Object({}),
    execute: async () => {
      const { listWorkflowsForAgent } =
        await import('~server/workflows/inspect');
      const workflows = await listWorkflowsForAgent();
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
      const { getWorkflowDetailForAgent } =
        await import('~server/workflows/inspect');
      const detail = await getWorkflowDetailForAgent(params.id);
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
      const { checkoutWorkflowForAgent } =
        await import('~server/workflows/git');
      const checkout = await checkoutWorkflowForAgent(sessionId, params.id);
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
      const { createWorkflow } = await import('~server/workflows/scaffold');
      const res = await createWorkflow(params, { sessionId });
      return text(
        `Created workflow "${res.id}". Source is at ${res.id}/.\n` +
          'Read the scaffolded files, edit workflow.ts (input schema + steps) ' +
          'and manifest.json (triggers), commit with git, then call ' +
          'deploy_workflow. Do not edit hatch/ (the platform SDK).',
        res,
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
      const { agentWorkflowWorkDir } = await import('~agent/paths');
      const { deployWorkflow } = await import('~server/workflows/deploy');
      const res = await deployWorkflow(params.id, {
        sourceDir: agentWorkflowWorkDir(sessionId, params.id),
        message: params.message,
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
      const { rollbackWorkflowToVersion } =
        await import('~server/workflows/manage');
      const res = await rollbackWorkflowToVersion(params.id, params.version);
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
