/** App lifecycle tools: list, inspect, checkout, create, deploy, rollback, DB. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  MAX_FILE_CHARS,
  requireSessionId,
  resolveAppHandle,
  text,
  tool,
} from './shared';

export function createAppTools(options: { sessionId?: string }): AgentTool[] {
  const listAppsTool = tool({
    name: 'list_apps',
    label: 'List apps',
    description:
      'List every app on the platform with its status, live version, and ' +
      'enabled capabilities. Use this to discover existing apps before ' +
      'calling get_app or checkout_app.',
    parameters: Type.Object({}),
    execute: async () => {
      const { listAppsForAgent } = await import('~server/apps/inspect');
      const apps = await listAppsForAgent();
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
      const id = await resolveAppHandle(params.id);
      const { getAppDetailForAgent } = await import('~server/apps/inspect');
      const detail = await getAppDetailForAgent(id);
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
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to checkout.' }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const id = await resolveAppHandle(params.id);
      const { checkoutAppForAgent } = await import('~server/apps/git');
      const checkout = await checkoutAppForAgent(sessionId, id);
      const lines = [
        `Checked out "${id}" at ${checkout.path}/.`,
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

  const createAppTool = tool({
    name: 'create_app',
    label: 'Create app',
    description:
      "Scaffold a new app from the platform template in this chat's " +
      'worktree with manifest, proto, Deno backend, React app, and a sample ' +
      'widget.',
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
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const { createApp } = await import('~server/apps/scaffold');
      const res = await createApp(params, { sessionId });
      return text(
        `Created app "${res.name}" (slug: ${res.slug}, id: ${res.id}). ` +
          `Source is at ${res.id}/.\n` +
          'Use the id for checkout_app/deploy_app. Read the scaffolded files, ' +
          'edit proto/backend/app/widgets, then commit your changes with git ' +
          'before calling deploy_app.',
        res,
      );
    },
  });

  const deployAppTool = tool({
    name: 'deploy_app',
    label: 'Deploy app',
    description:
      'Build (Connect codegen + bundle app/widgets + stage Deno backend) and ' +
      'deploy an app so it becomes live. Reports the app/widget/RPC URLs.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug to deploy.' }),
      message: Type.String({
        description:
          'Required release note describing what this deployment changes ' +
          '(e.g. "Add dark mode toggle"). Shown in the deployment history.',
      }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const id = await resolveAppHandle(params.id);
      const { agentAppWorkDir } = await import('~agent/paths');
      const { deployApp } = await import('~server/apps/deploy');
      const res = await deployApp(id, {
        sourceDir: agentAppWorkDir(sessionId, id),
        message: params.message,
      });
      // The baked manifest URL is keyed by the immutable id; surface the
      // human-facing /app/<slug>/ URL the user actually shares instead.
      const { appSlug } = await import('~server/apps/access');
      const slug = await appSlug(id);
      const lines = [
        `Deployed "${id}" (v${res.version}).`,
        res.normalized.app ? `App (iframe): /app/${slug ?? id}/` : null,
        res.normalized.widgets.length > 0
          ? `Widgets: ${res.normalized.widgets.map((w) => w.id).join(', ')}`
          : null,
        res.normalized.rpc ? `RPC: ${res.normalized.rpc.url}` : null,
      ].filter(Boolean);
      return text(lines.join('\n'), res);
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
      const id = await resolveAppHandle(params.id);
      const { rollbackAppToVersion } = await import('~server/apps/manage');
      const res = await rollbackAppToVersion(id, params.version);
      return text(
        `Rolled back "${id}" to v${res.version}. ` +
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
      const id = await resolveAppHandle(params.id);
      const { ensureAppDatabase } = await import('~server/apps/provision');
      const postgres = (await import('postgres')).default;
      const url = await ensureAppDatabase(id);
      // Bound the statement so a runaway query (e.g. an accidental cross join or
      // `pg_sleep`) can't hang the tool — and thus the whole agent turn — for
      // minutes. Abort tears the connection down promptly on cancel.
      const sql = postgres(url, {
        max: 1,
        connection: { statement_timeout: 30000 },
      });
      const onAbort = () => {
        void sql.end({ timeout: 0 }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort);
      try {
        const rows = await sql.unsafe(params.sql);
        const full =
          rows.length > 0
            ? JSON.stringify(rows.slice(0, 100), null, 2)
            : `OK (${rows.count} row(s) affected).`;
        // Cap by size too, not just row count: a few rows of large JSON/blobs
        // could otherwise dump megabytes into the model context (and persist
        // there for every later turn). Other tools already cap at MAX_FILE_CHARS.
        const body =
          full.length > MAX_FILE_CHARS
            ? `${full.slice(0, MAX_FILE_CHARS)}\n… (truncated)`
            : full;
        return text(body, { rowCount: rows.length });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await sql.end({ timeout: 5 });
      }
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
