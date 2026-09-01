/**
 * Workflow lifecycle tools: list, inspect, checkout, create, deploy, rollback.
 * Mirrors the app tools: platform state via PlatformClient, source in
 * runner-local worktrees fed by git bundles.
 */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { workflowHatchSdkMaterializer } from '../hatch-sdk';
import {
  assertWorkspacePathAvailable,
  bundleWorktreeForDeploy,
  checkoutFromBundle,
  initNewWorktree,
  type LocalCheckout,
  withSourceWorkspaceLock,
} from '../local-sources';
import { agentWorkflowWorkDir } from '../paths';
import type { PlatformClient } from '../platform-client';
import { writeScaffoldFiles } from '../scaffold-files';
import {
  materializeWorktree,
  WorktreeMaterializationError,
} from '../worktree-materializer';
import { resolveAgentWorkspacePath } from '../workspace-paths';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';
import {
  compatibilityDetailGuidance,
  compatibilityListSummary,
  compatibilityRollbackWarning,
} from './compatibility';
import { formatNetworkAccess } from './network-access';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

const WORKFLOW_COMPATIBILITY_COPY = {
  resourceName: 'Workflow',
  skillName: 'workflow-compatibility',
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkoutLines(id: string, checkout: LocalCheckout): string[] {
  return [
    checkout.replacedExisting
      ? `Replaced existing checkout for "${id}" at ${checkout.absolutePath}. ` +
        'All previous local work at that path was discarded.'
      : checkout.synchronizedExisting
        ? `Synchronized existing checkout for "${id}" at ` +
          `${checkout.absolutePath} to remote master.`
        : `Checked out "${id}" at ${checkout.absolutePath}.`,
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
}

function sdkPreparationFailure(context: string, error: unknown): Error {
  const stageError =
    error instanceof WorktreeMaterializationError && error.cause !== undefined
      ? error.cause
      : error;
  return new Error(
    `${context}, but Workflow preparation failed during SDK materialization: ` +
      errorMessage(stageError),
  );
}

export function createWorkflowTools(options: {
  sessionId?: string;
  platform: PlatformClient;
  /** Test seam for platform-owned SDK materialization. */
  materializeSdk?: (root: string) => Promise<void>;
}): AgentTool[] {
  const { platform } = options;
  const sdkMaterializer = {
    gitExcludePatterns: workflowHatchSdkMaterializer.gitExcludePatterns,
    materialize:
      options.materializeSdk ?? workflowHatchSdkMaterializer.materialize,
  };

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
        const compatibility = w.compatibility
          ? ` · compatibility v${w.compatibility.version}${compatibilityListSummary(w.compatibility, WORKFLOW_COMPATIBILITY_COPY)}`
          : '';
        const triggers = [
          w.cronCount > 0 ? `${w.cronCount} cron` : null,
          w.webhook ? 'webhook' : null,
        ]
          .filter(Boolean)
          .join(', ');
        return `- ${w.name} (id: ${w.id}, slug: ${w.slug}) [${w.status}]${version}${compatibility}${
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
      'network declaration, triggers (cron + webhook), recent runs, and ' +
      'deployment history. Mirrors the workflow management panel.',
    parameters: Type.Object({
      id: Type.String({
        description: 'Workflow id to inspect.',
      }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const detail = await platform.getWorkflow(params.id);
      if (!detail) throw new Error(`Workflow "${params.id}" not found.`);
      const lines: (string | null)[] = [
        `${detail.name} (id: ${detail.id}, slug: ${detail.slug}) — ` +
          detail.status +
          (detail.liveVersion != null
            ? ` · v${detail.liveVersion}`
            : ' · not deployed'),
        detail.description ? `Description: ${detail.description}` : null,
        `Workflow URL: /workflow/${detail.slug}`,
        detail.compatibility
          ? `Compatibility: v${detail.compatibility.version} ` +
            `(latest v${detail.compatibility.latestVersion}, minimum v${detail.compatibility.minimumSupportedVersion})` +
            compatibilityDetailGuidance(
              detail.compatibility,
              WORKFLOW_COMPATIBILITY_COPY,
            )
          : null,
        `Network: ${formatNetworkAccess(detail.network)}`,
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
          .map(
            (d) =>
              `  v${d.version} — ${d.status} · compatibility v${d.compatibility.version}${d.isCurrent ? ' (current)' : ''}${
                d.canRollback ? ' [rollbackable]' : ''
              }${
                !d.compatibility.isSupported
                  ? ' [Agent restore only; runtime disabled]'
                  : ''
              } · ${d.createdAt}${d.message ? ` · ${d.message}` : ''}${
                d.error ? ` · error: ${d.error}` : ''
              }`,
          ),
      ];
      return text(lines.filter((l) => l !== null).join('\n'), detail);
    },
  });

  const checkoutWorkflowTool = tool({
    name: 'checkout_workflow',
    label: 'Clone or update workflow',
    description:
      "Clone a workflow's Git repo into this conversation, or update an " +
      'existing checkout in place. Set clone: true to create a fresh checkout ' +
      'at source_path or workflows/<slug>. Set clone: false and provide ' +
      'source_path to update that exact checkout; update never creates or ' +
      'replaces a path. The platform-owned Hatch SDK is materialized before ' +
      'returning.',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.String({ description: 'Workflow id.' }),
      clone: Type.Boolean({
        description:
          'True to create a fresh checkout; false to update the existing ' +
          'checkout at source_path.',
      }),
      source_path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Required when clone is false. When clone is true, defaults ' +
            'to workflows/<slug>.',
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            'Only valid when clone is true. Replace an existing source_path ' +
            'with a fresh checkout. Defaults to false and permanently ' +
            'discards local work at that exact path.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      if (!params.clone && !params.source_path) {
        throw new Error('source_path is required when clone is false.');
      }
      if (!params.clone && params.force) {
        throw new Error('force is only valid when clone is true.');
      }
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          let sourcePath = params.source_path;
          let sourceWorkflowId = params.id;
          if (!sourcePath) {
            const detail = await platform.getWorkflow(params.id);
            if (!detail) throw new Error(`Workflow "${params.id}" not found.`);
            sourceWorkflowId = detail.id;
            sourcePath = agentWorkflowWorkDir(sessionId, detail.slug);
          }
          const source = await platform.getWorkflowSource(sourceWorkflowId);
          const resolved = await resolveAgentWorkspacePath(
            sessionId,
            sourcePath,
          );
          let checkout: LocalCheckout;
          try {
            checkout = await checkoutFromBundle(sessionId, 'workflow', source, {
              targetPath: sourcePath,
              force: params.clone ? (params.force ?? false) : false,
              mode: params.clone ? 'clone' : 'update',
              materializer: sdkMaterializer,
            });
          } catch (error) {
            if (error instanceof WorktreeMaterializationError) {
              throw sdkPreparationFailure(
                `Checked out "${source.id}" at ${resolved.absolutePath}`,
                error,
              );
            }
            throw error;
          }
          return text(checkoutLines(source.id, checkout).join('\n'), checkout);
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
      'worktree (manifest and a `workflow.ts` defining a zod input + steps). ' +
      'The platform-owned @hatch/workflow SDK is generated before returning. ' +
      'Workflows run periodic/repetitive tasks; they ' +
      'have no custom UI/API, only manual/cron/webhook triggers.',
    executionMode: 'sequential',
    parameters: Type.Object({
      slug: Type.String({
        maxLength: WORKFLOW_SLUG_MAX_LENGTH,
        description:
          'kebab-case URL slug, e.g. "digest" or "sync-stars". Used in ' +
          'the human-facing /workflow/<slug> URL and changeable later; ' +
          'technical APIs use the generated Workflow id.',
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
            'it. Defaults to workflows/<slug>.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const { target_path: requestedTargetPath, ...input } = params;
          const targetPath =
            requestedTargetPath ??
            agentWorkflowWorkDir(sessionId, input.slug.trim());
          await assertWorkspacePathAvailable(sessionId, targetPath);
          const res = await platform.createWorkflow(input);
          const checkout = await initNewWorktree(
            sessionId,
            'workflow',
            res.id,
            (root) => writeScaffoldFiles(root, res.files),
            targetPath,
          );
          const context =
            `Created workflow "${res.name}" (slug: ${res.slug}, id: ` +
            `${res.id}) at ${checkout.absolutePath}`;
          try {
            await materializeWorktree(checkout.absolutePath, sdkMaterializer);
          } catch (error) {
            throw sdkPreparationFailure(context, error);
          }
          return text(
            `Created workflow "${res.name}" (id: ${res.id}, slug: ` +
              `${res.slug}). Source is at ${checkout.absolutePath}.\n` +
              'Read the scaffolded files, edit workflow.ts (input schema + steps) ' +
              'and manifest.json (compatibility version + network policy + triggers), ' +
              'commit with git, then call ' +
              `deploy_workflow with id "${res.id}" and source_path ` +
              `"${checkout.absolutePath}". The generated .hatch/ directory is platform-owned; ` +
              'do not edit or commit it.',
            {
              id: res.id,
              slug: res.slug,
              name: res.name,
              path: checkout.path,
              absolutePath: checkout.absolutePath,
              preparation: 'ready',
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
      'to repair dependency configuration errors. manifest.json must explicitly ' +
      'declare a supported compatibilityVersion. Reports the deployment and ' +
      'compatibility versions plus the webhook URL (if enabled).',
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
            params.source_path,
          );
          const res = await platform.deployWorkflow(detail.id, {
            message: params.message,
            generation: detail.createdAt,
            bundleBase64,
          });
          const lines = [
            `Deployed "${detail.id}" (v${res.version}, compatibility v${res.compatibilityVersion}).`,
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
      "version's bundled program and source. Agent restore remains available " +
      "outside the platform's supported compatibility range, but that " +
      'Workflow cannot run until the Workflow or platform is updated.',
    parameters: Type.Object({
      id: Type.String({
        description: 'Workflow id to roll back.',
      }),
      version: Type.Number({ description: 'Deployment version to restore.' }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const res = await platform.rollbackWorkflow(params.id, params.version);
      const compatibilityWarning = compatibilityRollbackWarning(
        res.compatibility,
        WORKFLOW_COMPATIBILITY_COPY,
      );
      return text(
        `Rolled "${params.id}" back to v${res.version}.` +
          (compatibilityWarning ? ` ${compatibilityWarning}` : '') +
          ' Existing Agent ' +
          'worktrees were not changed. Re-run checkout_workflow with the same ' +
          'source_path and clone: false. It synchronizes only when remote ' +
          'master fast-forwards a clean local master; ahead or diverged work ' +
          'is preserved. To discard it, make a separate clone: true call with ' +
          'the same source_path and force: true.',
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
