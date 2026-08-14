/**
 * App lifecycle tools: list, inspect, checkout, create, deploy, rollback,
 * database, persistent storage, and KV.
 * All platform state flows through the injected PlatformClient (REST to the
 * platform's internal API); source trees live in runner-local worktrees fed
 * by git bundles.
 */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  AppPreparationError,
  prepareAppWorktree,
} from '../app-worktree-prepare';
import { appHatchSdkMaterializer } from '../hatch-sdk';
import {
  assertWorkspacePathAvailable,
  bundleWorktreeForDeploy,
  checkoutFromBundle,
  initNewWorktree,
  type LocalCheckout,
  withSourceWorkspaceLock,
} from '../local-sources';
import { agentAppWorkDir } from '../paths';
import type { PlatformClient } from '../platform-client';
import {
  QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
  queryAppDataTableRequestSchema,
  queryAppKvRequestSchema,
} from '../protocol';
import { writeScaffoldFiles } from '../scaffold-files';
import {
  materializeWorktree,
  WorktreeMaterializationError,
} from '../worktree-materializer';
import { resolveAgentWorkspacePath } from '../workspace-paths';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preparationFailure(
  context: string,
  stage: 'SDK materialization' | 'dependency install or Connect codegen',
  error: unknown,
): Error {
  const stageError =
    error instanceof WorktreeMaterializationError && error.cause !== undefined
      ? error.cause
      : error;
  const reason =
    stageError instanceof AppPreparationError
      ? stageError.message
      : `App preparation failed during ${stage}: ${errorMessage(stageError)}`;
  return new Error(`${context}, but ${reason}`);
}

type PrepareWorktree = (root: string, signal?: AbortSignal) => Promise<void>;

export function createAppTools(options: {
  sessionId?: string;
  platform: PlatformClient;
  /** Test seam for platform-owned SDK materialization. */
  materializeSdk?: (root: string) => Promise<void>;
  /** Test seam for the generated dependency/codegen preparation step. */
  prepareWorktree?: PrepareWorktree;
}): AgentTool[] {
  const { platform } = options;
  const materializeSdk =
    options.materializeSdk ?? appHatchSdkMaterializer.materialize;
  const sdkMaterializer = {
    gitExcludePatterns: appHatchSdkMaterializer.gitExcludePatterns,
    materialize: materializeSdk,
  };
  const prepareWorktree = options.prepareWorktree ?? prepareAppWorktree;

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
      'normalized manifest (app/widget/RPC/webhook URLs), runtime ' +
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
        detail.ops.dataTable.enabled
          ? `Data Tables: ${detail.ops.dataTable.dbName ?? 'not provisioned'} ` +
            `(${detail.ops.dataTable.schemaHash?.slice(0, 10) ?? 'no schema'})`
          : null,
        detail.ops.storage.enabled
          ? 'Persistent storage: enabled (backend STORAGE_DIR)'
          : null,
        `Capabilities: ${
          detail.capabilities.length > 0
            ? detail.capabilities.join(', ')
            : 'none detected yet'
        }`,
        m?.app ? `App URL: ${m.app.url}` : null,
        m?.rpc ? `RPC: ${m.rpc.url} (${m.rpc.service})` : null,
        m && m.widgets.length > 0
          ? `Widgets: ${m.widgets.map((w) => `${w.id} (${w.url})`).join(', ')}`
          : null,
        detail.ops.webhook.enabled
          ? `Webhook: ${detail.ops.webhook.url ?? 'n/a'}${
              detail.ops.webhook.hasSecret ? ' [secret set]' : ''
            }`
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
              }${d.dataSchemaMismatch ? ' [Data Table schema differs]' : ''} · ${
                d.createdAt
              }`,
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
      'Use before reading or editing an existing app. An existing target is ' +
      'synchronized only when it is the same owned checkout, clean, on master, ' +
      'and remote master is a fast-forward; otherwise it fails unless force is ' +
      'true. Before returning, it reproduces frozen dependencies, generates ' +
      'Connect stubs, and materializes the platform-owned Hatch SDK. App ' +
      'dependencies that require npm lifecycle scripts are rejected.',
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
          const source = await platform.getAppSource(params.id);
          const resolved = await resolveAgentWorkspacePath(
            sessionId,
            params.target_path ?? agentAppWorkDir(sessionId, source.id),
          );
          let checkout: LocalCheckout;
          try {
            checkout = await checkoutFromBundle(sessionId, 'app', source, {
              targetPath: params.target_path,
              force: params.force ?? false,
              materializer: sdkMaterializer,
            });
          } catch (error) {
            if (error instanceof WorktreeMaterializationError) {
              throw preparationFailure(
                `Checked out "${source.id}" at ${resolved.absolutePath}`,
                'SDK materialization',
                error,
              );
            }
            throw error;
          }
          const context = `Checked out "${source.id}" at ${checkout.absolutePath}`;
          try {
            await prepareWorktree(checkout.absolutePath, signal);
          } catch (error) {
            throw preparationFailure(
              context,
              'dependency install or Connect codegen',
              error,
            );
          }
          return text(
            [
              ...checkoutLines(source.id, checkout),
              'Preparation: ready (dependencies, Connect stubs, Hatch SDK).',
            ].join('\n'),
            { ...checkout, preparation: 'ready' },
          );
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
      'widget. Before returning, it reproduces frozen dependencies, generates ' +
      'Connect stubs, and materializes the platform-owned Hatch SDK. App ' +
      'dependencies that require npm lifecycle scripts are rejected.',
    executionMode: 'sequential',
    parameters: Type.Object({
      slug: Type.String({
        description:
          'kebab-case URL slug, e.g. "todo" or "habit-tracker". Used in the ' +
          'human-facing /app/<slug> URL. It can be ' +
          'changed later from the manage page, so it is not permanent; ' +
          'technical APIs use the immutable app id.',
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
          const context =
            `Created app "${res.name}" (slug: ${res.slug}, id: ${res.id}) ` +
            `at ${checkout.absolutePath}`;
          try {
            await materializeWorktree(checkout.absolutePath, sdkMaterializer);
          } catch (error) {
            throw preparationFailure(context, 'SDK materialization', error);
          }
          try {
            await prepareWorktree(checkout.absolutePath, signal);
          } catch (error) {
            throw preparationFailure(
              context,
              'dependency install or Connect codegen',
              error,
            );
          }
          return text(
            [
              `Created app "${res.name}" (slug: ${res.slug}, id: ${res.id}). ` +
                `Source is at ${checkout.absolutePath}.`,
              'Preparation is ready: dependencies, Connect stubs, and the Hatch ' +
                'SDK are available. Use the id for checkout_app/deploy_app. Read ' +
                'and edit the authored files, run the checks described by the ' +
                'building-apps Skill, then commit before calling deploy_app.',
            ].join('\n'),
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

  const deployAppTool = tool({
    name: 'deploy_app',
    label: 'Deploy app',
    description:
      'Validate and deploy a committed app so it becomes live. Deploy uses ' +
      'trusted Connect codegen, a frozen dependency install, source-level Deno ' +
      'checks for every enabled manifest entry, and production bundles before ' +
      'database migration or release activation. Requires package.json, ' +
      'deno.json, and a committed deno.lock; load the building-apps Skill to ' +
      'repair validation errors. Reports the app/widget/RPC URLs.',
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
          '(e.g. "Add CSV export"). Shown in the deployment history.',
      }),
      allow_destructive_data_migration: Type.Optional(
        Type.Boolean({
          description:
            'Set true only after the user explicitly approves the destructive ' +
            'Data Table migration preview returned by a previous deploy attempt.',
        }),
      ),
      data_migration_approval_token: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Exact approval token returned by the destructive Data Table ' +
            'migration preview. Pass it together with ' +
            'allow_destructive_data_migration: true.',
        }),
      ),
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
            allowDestructiveDataMigration:
              params.allow_destructive_data_migration,
            dataMigrationApprovalToken: params.data_migration_approval_token,
          });
          const lines = [
            `Deployed "${detail.id}" (v${res.version}).`,
            res.normalized.app
              ? `App (iframe): ${res.normalized.app.url}`
              : null,
            res.normalized.widgets.length > 0
              ? `Widgets: ${res.normalized.widgets.map((w) => w.id).join(', ')}`
              : null,
            res.normalized.rpc ? `RPC: ${res.normalized.rpc.url}` : null,
            res.normalized.dataTable
              ? `Data Tables: ${res.normalized.dataTable.url}`
              : null,
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
          (res.dataSchemaMismatch
            ? 'Warning: the managed Data Table schema was not rolled back and differs from this code version. '
            : '') +
          'Existing Agent worktrees were not changed. Re-run checkout_app with ' +
          'the same target_path. It synchronizes only when remote master ' +
          'fast-forwards a clean local master; ahead or diverged work is ' +
          'preserved. Fetch/rebase to retain that work, or use force: true only ' +
          'when discarding and replacing the checkout is intended.',
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

  const queryAppKv = tool({
    name: 'query_app_kv',
    label: 'Query app KV',
    description:
      "List, read, write, or permanently delete entries in a deployed app's " +
      'KV store. Secret values are masked by default. For list and get, set ' +
      'reveal_secrets to true only when their plaintext is needed in the model ' +
      'context. The app must already have the kv capability enabled.',
    // Keep the root object-shaped: the Anthropic adapter forwards root
    // properties/required fields and would discard a root anyOf schema.
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug.' }),
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('get'),
        Type.Literal('set'),
        Type.Literal('delete'),
      ]),
      key: Type.Optional(
        Type.String({
          description: 'Required for get, set, and delete.',
        }),
      ),
      value: Type.Optional(
        Type.String({
          description: 'Plaintext string value. Required for set.',
        }),
      ),
      secret: Type.Optional(
        Type.Boolean({
          description:
            'Set only: secret flag. Omit to preserve it on update; new keys ' +
            'default to false.',
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          description: 'List only: cursor returned by the previous call.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: 'List only: maximum entries. Defaults to 100.',
        }),
      ),
      reveal_secrets: Type.Optional(
        Type.Boolean({
          description:
            'List and get only: return secret values in plaintext. Defaults ' +
            'to false.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      const { id, reveal_secrets: revealSecrets, ...rawInput } = params;
      // The object-rooted provider schema exposes every field. Enforce the
      // action-specific required/allowed combinations before making the REST
      // request, using the same contract as the platform endpoint.
      const input = queryAppKvRequestSchema.parse({
        ...rawInput,
        ...(revealSecrets === undefined ? {} : { revealSecrets }),
      });
      const cursor = input.action === 'list' ? input.cursor : undefined;
      const key = input.action === 'list' ? undefined : input.key;
      const res = await platform.queryAppKv(id, input, signal);
      switch (res.action) {
        case 'list': {
          if (res.items.length === 0) {
            return text(
              cursor
                ? `No KV entries found after cursor ${JSON.stringify(cursor)}.`
                : `App "${id}" has no KV entries.`,
              res,
            );
          }
          const continuation = res.nextCursor
            ? `\nContinue with cursor: ${JSON.stringify(res.nextCursor)}`
            : '';
          return text(
            `${JSON.stringify(res.items, null, 2)}${continuation}`,
            res,
          );
        }
        case 'get':
          return res.record
            ? text(JSON.stringify(res.record, null, 2), res)
            : text(`KV key ${JSON.stringify(key)} is not set.`, res);
        case 'set':
          return text(JSON.stringify(res.record, null, 2), res);
        case 'delete':
          return text(
            res.ok
              ? `Deleted KV key ${JSON.stringify(key)} permanently.`
              : `KV key ${JSON.stringify(key)} was not set.`,
            res,
          );
      }
    },
  });

  const queryAppDataTable = tool({
    name: 'query_app_data_table',
    label: 'Query app Data Table',
    description:
      "Inspect, query, or mutate a deployed app's managed Data Tables. " +
      'Always prefer the structured inspect, query, and mutate actions. ' +
      'raw_sql is a dangerous last resort only when the structured actions ' +
      'cannot express the required joins, aggregates, or complex data repair. ' +
      'raw_sql may only query or modify rows with SELECT, INSERT, UPDATE, ' +
      'DELETE, MERGE, CTEs, joins, aggregates, or upserts. Never use raw_sql ' +
      'for DDL, TRUNCATE, maintenance, transaction control, permissions, ' +
      'roles, databases, or any _hatch object. This is an instruction, not a ' +
      'runtime SQL restriction. Raw SQL bypasses managed validation and may ' +
      'contain multiple statements; unqualified tables resolve in data then ' +
      'public. timeout_ms controls the Raw SQL database operation only; it ' +
      'does not cover App resolution or capability preflight and defaults to ' +
      '30000.',
    // Keep the root object-shaped: the Anthropic adapter forwards root
    // properties/required fields and would discard a root anyOf schema.
    parameters: Type.Object({
      id: Type.String({ description: 'App id or slug.' }),
      action: Type.Union([
        Type.Literal('inspect'),
        Type.Literal('query'),
        Type.Literal('mutate'),
        Type.Literal('raw_sql'),
      ]),
      table: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Inspect: optional table to inspect. Query: required table name.',
        }),
      ),
      where: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String({ minLength: 1 }),
            op: Type.Union([
              Type.Literal('eq'),
              Type.Literal('ne'),
              Type.Literal('gt'),
              Type.Literal('gte'),
              Type.Literal('lt'),
              Type.Literal('lte'),
              Type.Literal('in'),
            ]),
            value: Type.Any({
              description:
                'JSON value to compare; use an array with the in operator.',
            }),
          }),
          {
            maxItems: 16,
            description: 'Query only: AND-combined filters.',
          },
        ),
      ),
      order_by: Type.Optional(
        Type.Object(
          {
            field: Type.String({ minLength: 1 }),
            direction: Type.Optional(
              Type.Union([Type.Literal('asc'), Type.Literal('desc')]),
            ),
          },
          { description: 'Query only: sort field and direction.' },
        ),
      ),
      cursor: Type.Optional(
        Type.String({
          maxLength: QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
          description: 'Query only: cursor returned by the previous call.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: 'Query only: maximum rows. Defaults to 50.',
        }),
      ),
      operations: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.Union([
              Type.Literal('insert'),
              Type.Literal('patch'),
              Type.Literal('increment'),
              Type.Literal('delete'),
            ]),
            table: Type.String({ minLength: 1 }),
            id: Type.Optional(Type.String({ minLength: 1 })),
            value: Type.Optional(
              Type.Record(Type.String(), Type.Any(), {
                description: 'Insert or patch field values.',
              }),
            ),
            unset: Type.Optional(
              Type.Array(Type.String({ minLength: 1 }), {
                description: 'Patch only: optional fields to clear.',
              }),
            ),
            field: Type.Optional(
              Type.String({
                minLength: 1,
                description: 'Increment only: numeric field name.',
              }),
            ),
            amount: Type.Optional(
              Type.Number({
                description: 'Increment only: finite amount to add.',
              }),
            ),
          }),
          {
            minItems: 1,
            maxItems: 100,
            description:
              'Mutate only: atomic operations; any failure rolls back all.',
          },
        ),
      ),
      sql: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'raw_sql only: SQL for querying or modifying existing rows. ' +
            'Never use DDL, TRUNCATE, maintenance, transaction control, or ' +
            '_hatch objects. Physical system columns use created_at and ' +
            'updated_at.',
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          minimum: 1_000,
          maximum: 1_800_000,
          description:
            'raw_sql only: timeout for the Raw SQL database operation, ' +
            'including statement execution, in milliseconds. It does not ' +
            'cover App resolution or capability preflight. Defaults to 30000.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      const {
        id,
        order_by: orderBy,
        timeout_ms: timeoutMs,
        ...rawInput
      } = params;
      // The provider-facing schema must stay object-rooted. Apply the strict
      // action-specific contract after translating its snake_case fields.
      const input = queryAppDataTableRequestSchema.parse({
        ...rawInput,
        ...(orderBy === undefined ? {} : { orderBy }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      const res = await platform.queryAppDataTable(id, input, signal);
      switch (res.action) {
        case 'inspect':
          if (!res.data) {
            return text(`App "${id}" has no live Data Table schema.`, res);
          }
          return text(
            JSON.stringify(res.data, null, 2) +
              (res.data.truncated
                ? '\nThe full schema exceeded the output budget. Inspect ' +
                  'individual tables by passing a table name from ' +
                  'data/schema.ts.'
                : ''),
            res,
          );
        case 'query': {
          if (res.items.length === 0) {
            return text(
              input.action === 'query' && input.cursor
                ? `No Data Table rows found after the provided cursor. Revision: ${res.revision}.`
                : `The Data Table query returned no rows. Revision: ${res.revision}.`,
              res,
            );
          }
          const continuation = res.cursor
            ? `\nContinue with cursor: ${JSON.stringify(res.cursor)}`
            : '';
          const truncation = res.truncated
            ? '\nOutput was truncated. Continue with the returned cursor.'
            : '';
          return text(
            `${JSON.stringify(res.items, null, 2)}\nRevision: ${res.revision}.` +
              `${continuation}${truncation}`,
            res,
          );
        }
        case 'mutate': {
          const missing = res.results.flatMap((result, index) =>
            result === null ? [index + 1] : [],
          );
          return text(
            `${JSON.stringify(res.results, null, 2)}\nRevision: ${res.revision}.` +
              (missing.length > 0
                ? `\nNo row was found for operation(s): ${missing.join(', ')}.`
                : ''),
            res,
          );
        }
        case 'raw_sql':
          return text(
            JSON.stringify(res.results, null, 2) +
              (res.truncated
                ? '\nOutput was truncated. Rerun raw_sql with narrower ' +
                  'columns, LIMIT, keyset conditions, or SQL substring ' +
                  'functions.'
                : ''),
            res,
          );
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
    queryAppKv,
    queryAppDataTable,
  ];
}
