/**
 * App lifecycle tools: list, inspect, checkout, create, deploy, rollback, DB.
 * All platform state flows through the injected PlatformClient (REST to the
 * platform's internal API); source trees live in runner-local worktrees fed
 * by git bundles.
 */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  assertWorkspacePathAvailable,
  bundleWorktreeForDeploy,
  initNewWorktree,
  syncCheckoutFromBundle,
  type LocalCheckout,
  withSourceWorkspaceLock,
} from '../local-sources';
import type { PlatformClient } from '../platform-client';
import { writeScaffoldFiles } from '../scaffold-files';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

function checkoutLines(id: string, checkout: LocalCheckout): string[] {
  return [
    `Checked out "${id}" at ${checkout.absolutePath}.`,
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

export function createAppTools(options: {
  sessionId?: string;
  platform: PlatformClient;
}): AgentTool[] {
  const { platform } = options;

  const listAppsTool = tool({
    name: 'list_apps',
    label: 'List apps',
    description:
      'List every app on the platform with its status, live version, and ' +
      'enabled capabilities. Use this to discover existing apps before ' +
      'calling get_app or checkout_app.',
    parameters: Type.Object({}),
    execute: async () => {
      const apps = await platform.listApps();
      if (apps.length === 0) {
        return text('No apps exist yet.', { apps });
      }
      const lines = apps.map((a) => {
        const version =
          a.currentVersion != null
            ? ` v${a.currentVersion}`
            : ' (not deployed)';
        const caps =
          a.capabilities.length > 0 ? ` — ${a.capabilities.join(', ')}` : '';
        return `- ${a.slug} · ${a.name} (id: ${a.id}) [${a.status}]${version}${caps}`;
      });
      return text(lines.join('\n'), { apps });
    },
  });

  const getAppTool = tool({
    name: 'get_app',
    label: 'Get app details',
    description:
      "Get one app's details: status, live version, capabilities, the " +
      'normalized manifest (app/widget/RPC/webhook/storage URLs), runtime ' +
      'state (backend running, cron jobs), and deployment history. Mirrors ' +
      'the app management panel.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to inspect.' }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const detail = await platform.getApp(params.id);
      if (!detail) throw new Error(`App "${params.id}" not found.`);
      const m = detail.manifest;
      const lines: (string | null)[] = [
        `${detail.name} (slug: ${detail.slug}, id: ${detail.id}) — ${detail.status}` +
          (detail.currentVersion != null
            ? ` · v${detail.currentVersion}`
            : ' · not deployed'),
        detail.description ? `Description: ${detail.description}` : null,
        `Backend: ${
          detail.ops.backend.capable
            ? `${detail.backendMode ?? 'serverless'}${
                detail.ops.backend.running ? ' (running)' : ''
              }`
            : 'none'
        }`,
        `Database: ${detail.dbName ?? 'not provisioned'}`,
        `Capabilities: ${
          detail.capabilities.length > 0
            ? detail.capabilities.join(', ')
            : 'none detected yet'
        }`,
        m?.app ? `App URL: /app/${detail.slug}/` : null,
        m?.rpc ? `RPC: ${m.rpc.url} (${m.rpc.service})` : null,
        m && m.widgets.length > 0
          ? `Widgets: ${m.widgets.map((w) => `${w.id} (${w.url})`).join(', ')}`
          : null,
        detail.ops.webhook.enabled
          ? `Webhook: ${detail.ops.webhook.url ?? 'n/a'}${
              detail.ops.webhook.hasSecret ? ' [secret set]' : ''
            }`
          : null,
        detail.ops.storage.enabled
          ? `Storage: ${detail.ops.storage.url ?? 'n/a'} (${
              detail.ops.storage.objectCount
            } object(s))`
          : null,
        detail.ops.cron.enabled
          ? `Cron: ${
              detail.ops.cron.jobs.length > 0
                ? detail.ops.cron.jobs
                    .map((j) => `${j.name} [${j.schedule}]`)
                    .join(', ')
                : 'no jobs'
            }`
          : null,
        '',
        'Deployments (newest first):',
        ...detail.deployments
          .slice(0, 10)
          .map(
            (d) =>
              `  v${d.version} — ${d.status}${d.isCurrent ? ' (current)' : ''}${
                d.canRollback ? ' [rollbackable]' : ''
              } · ${d.createdAt}`,
          ),
      ];
      return text(lines.filter((l) => l !== null).join('\n'), detail);
    },
  });

  const checkoutAppTool = tool({
    name: 'checkout_app',
    label: 'Checkout app',
    description:
      "Checkout an app's Git repo into this chat's persistent worktree. " +
      'Use before reading or editing an existing app.',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to checkout.' }),
      target_path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Defaults to apps/<app-id>.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const source = await platform.getAppSource(params.id);
          const checkout = await syncCheckoutFromBundle(
            sessionId,
            'app',
            source,
            params.target_path,
          );
          return text(checkoutLines(source.id, checkout).join('\n'), checkout);
        },
        signal,
      );
    },
  });

  const createAppTool = tool({
    name: 'create_app',
    label: 'Create app',
    description:
      "Scaffold a new app from the platform template in this chat's " +
      'worktree with manifest, proto, Deno backend, React app, and a sample ' +
      'widget.',
    executionMode: 'sequential',
    parameters: Type.Object({
      slug: Type.String({
        description:
          'kebab-case URL slug, e.g. "todo" or "habit-tracker". Appears in the ' +
          'app URL (/app/<slug>/) and can be changed later from the manage ' +
          'page, so it is not permanent.',
      }),
      name: Type.String({ description: 'Human-readable name.' }),
      description: Type.Optional(
        Type.String({ description: 'One-line description.' }),
      ),
      pin: Type.Optional(
        Type.Boolean({
          description:
            'Pin the app to the sidebar. Pass true when the app will have a ' +
            'user-facing frontend (the default) so it is reachable right away, ' +
            'and false for backend-only or widget-only apps.',
        }),
      ),
      target_path: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Defaults to apps/<generated-app-id>.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const { target_path: targetPath, ...input } = params;
          if (targetPath !== undefined) {
            // Keep validation and local initialization under one session lock so
            // parallel create calls cannot both reserve the same target.
            await assertWorkspacePathAvailable(sessionId, targetPath);
          }
          const res = await platform.createApp(input);
          const checkout = await initNewWorktree(
            sessionId,
            'app',
            res.id,
            res.generation,
            (root) => writeScaffoldFiles(root, res.files),
            targetPath,
          );
          return text(
            `Created app "${res.name}" (slug: ${res.slug}, id: ${res.id}). ` +
              `Source is at ${checkout.absolutePath}.\n` +
              'Use the id for checkout_app/deploy_app. Read the scaffolded files, ' +
              'edit proto/backend/app/widgets, then commit your changes with git ' +
              'before calling deploy_app.',
            {
              id: res.id,
              slug: res.slug,
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

  const deployAppTool = tool({
    name: 'deploy_app',
    label: 'Deploy app',
    description:
      'Build (Connect codegen + bundle app/widgets + stage Deno backend) and ' +
      'deploy an app so it becomes live. Requires package.json, deno.json, and ' +
      'a committed deno.lock; load the building-apps Skill to repair dependency ' +
      'configuration errors. Reports the app/widget/RPC URLs.',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to deploy.' }),
      source_path: Type.String({
        minLength: 1,
        description:
          'Absolute path inside this Agent workdir, or a path relative to it, ' +
          'for the app Git worktree. Use the path returned by create_app or ' +
          'checkout_app.',
      }),
      message: Type.String({
        description:
          'Required release note describing what this deployment changes ' +
          '(e.g. "Add dark mode toggle"). Shown in the deployment history.',
      }),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const detail = await platform.getApp(params.id);
          if (!detail) throw new Error(`App "${params.id}" not found.`);
          const { bundleBase64 } = await bundleWorktreeForDeploy(
            sessionId,
            'app',
            detail.id,
            detail.createdAt,
            params.source_path,
          );
          const res = await platform.deployApp(detail.id, {
            message: params.message,
            generation: detail.createdAt,
            bundleBase64,
          });
          const lines = [
            `Deployed "${detail.id}" (v${res.version}).`,
            res.normalized.app ? `App (iframe): /app/${res.slug}/` : null,
            res.normalized.widgets.length > 0
              ? `Widgets: ${res.normalized.widgets.map((w) => w.id).join(', ')}`
              : null,
            res.normalized.rpc ? `RPC: ${res.normalized.rpc.url}` : null,
          ].filter(Boolean);
          return text(lines.join('\n'), res);
        },
        signal,
      );
    },
  });

  const rollbackAppTool = tool({
    name: 'rollback_app',
    label: 'Rollback app',
    description:
      'Rollback an app to a previous deployment version. Restores that ' +
      "version's artifact and moves the app repo master branch to its " +
      'deployment tag commit. Pass the version number shown by get_app ' +
      '(e.g. 4 to restore v4); only successfully deployed versions can be ' +
      'restored.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to rollback.' }),
      version: Type.Number({
        description: 'Deployment version to restore, e.g. 4 for v4.',
      }),
    }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const res = await platform.rollbackApp(params.id, params.version);
      return text(
        `Rolled back "${params.id}" to v${res.version}. ` +
          'Run checkout_app or git fetch/rebase in existing worktrees before ' +
          'making more changes.',
        res,
      );
    },
  });

  const queryAppDb = tool({
    name: 'query_app_db',
    label: 'Query app DB',
    description:
      "Run SQL against an app's own Postgres database (provisioned on first " +
      'use). Use to create tables and inspect data. Returns up to 100 rows.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug.' }),
      sql: Type.String({ description: 'SQL statement to execute.' }),
    }),
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      // Forward the abort signal so cancelling the run aborts the platform
      // request, which in turn tears down the running statement.
      const res = await platform.queryAppDb(params.id, params.sql, signal);
      return text(res.text, { rowCount: res.rowCount });
    },
  });

  return [
    listAppsTool,
    getAppTool,
    checkoutAppTool,
    createAppTool,
    deployAppTool,
    rollbackAppTool,
    queryAppDb,
  ];
}
