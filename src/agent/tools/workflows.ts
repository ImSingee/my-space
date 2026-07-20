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
  checkoutFromBundle,
  initNewWorktree,
  withSourceWorkspaceLock,
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
      'Use before reading or editing an existing workflow. An existing target ' +
      'is synchronized only when it is the same owned checkout, clean, on ' +
      'master, and remote master is a fast-forward; otherwise it fails unless ' +
      'force is true.',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to checkout.' }),
      target_path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Defaults to workflows/<workflow-id>.',
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            'Replace an existing target_path with a fresh checkout. Defaults ' +
            'to false. This permanently discards all local work at that path.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const source = await platform.getWorkflowSource(params.id);
          const checkout = await checkoutFromBundle(
            sessionId,
            'workflow',
            source,
            {
              targetPath: params.target_path,
              force: params.force ?? false,
            },
          );
          const lines = [
            checkout.replacedExisting
              ? `Replaced existing checkout for "${params.id}" at ` +
                `${checkout.absolutePath}. All previous local work at that ` +
                'path was discarded.'
              : checkout.synchronizedExisting
                ? `Synchronized existing checkout for "${params.id}" at ` +
                  `${checkout.absolutePath} to remote master.`
                : `Checked out "${params.id}" at ${checkout.absolutePath}.`,
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
        signal,
      );
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
    executionMode: 'sequential',
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
      target_path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Defaults to workflows/<workflow-id>.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          // The workflow id doubles as the local directory name; reserve it
          // before the Platform registers the id.
          await assertWorktreeAvailable(
            sessionId,
            'workflow',
            params.id,
            params.target_path,
          );
          const { target_path: targetPath, ...input } = params;
          const res = await platform.createWorkflow(input);
          const checkout = await initNewWorktree(
            sessionId,
            'workflow',
            res.id,
            res.generation,
            (root) => writeScaffoldFiles(root, res.files),
            targetPath,
          );
          return text(
            `Created workflow "${res.id}". Source is at ` +
              `${checkout.absolutePath}.\n` +
              'Read the scaffolded files, edit workflow.ts (input schema + steps) ' +
              'and manifest.json (triggers), commit with git, then call ' +
              'deploy_workflow. Do not edit hatch/ (the platform SDK).',
            {
              id: res.id,
              name: res.name,
              path: checkout.path,
              absolutePath: checkout.absolutePath,
            },
          );
        },
        signal,
      );
    },
  });

  const deployWorkflowTool = tool({
    name: 'deploy_workflow',
    label: 'Deploy workflow',
    description:
      'Bundle the workflow into a single Deno program, capture its input JSON ' +
      'Schema, and deploy it so it can be triggered. Requires package.json, ' +
      'deno.json, and a committed deno.lock; load the building-workflows Skill ' +
      'to repair dependency configuration errors. Reports the version and ' +
      'webhook URL (if enabled).',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id to deploy.' }),
      source_path: Type.String({
        minLength: 1,
        description:
          'Absolute path inside this Agent workdir, or a path relative to it, ' +
          'for the workflow Git worktree. Use the path returned by ' +
          'create_workflow or checkout_workflow.',
      }),
      message: Type.String({
        description:
          'Required release note describing what this deployment changes ' +
          '(shown in the deployment history).',
      }),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const detail = await platform.getWorkflow(params.id);
          if (!detail) throw new Error(`Workflow "${params.id}" not found.`);
          const { bundleBase64 } = await bundleWorktreeForDeploy(
            sessionId,
            'workflow',
            detail.id,
            detail.createdAt,
            params.source_path,
          );
          const res = await platform.deployWorkflow(detail.id, {
            message: params.message,
            generation: detail.createdAt,
            bundleBase64,
          });
          const lines = [
            `Deployed "${detail.id}" (v${res.version}).`,
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
        signal,
      );
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
      return text(
        `Rolled "${params.id}" back to v${res.version}. Existing Agent ` +
          'worktrees were not changed. Re-run checkout_workflow with the same ' +
          'target_path. It synchronizes only when remote master fast-forwards ' +
          'a clean local master; ahead or diverged work is preserved. ' +
          'Fetch/rebase to retain that work, or use force: true only when ' +
          'discarding and replacing the checkout is intended.',
        res,
      );
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
