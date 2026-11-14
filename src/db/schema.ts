import { sql } from 'drizzle-orm';
import {
  timestamp as _timestamp,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { monotonicFactory } from 'ulid';
import { session, user } from './auth-schema';
import type { HomepageTarget } from '../homepage';

export * from './auth-schema';

/** ================== utils ================== */
function timestamp(name?: string) {
  if (!name) {
    return _timestamp({ withTimezone: true, mode: 'date' });
  }
  return _timestamp(name, { withTimezone: true, mode: 'date' });
}

// Monotonic within a process, so ids also order rows created in the same
// millisecond (Agent runs rely on id order to find a session's latest run).
const genUlid0 = monotonicFactory();

function genUlid() {
  return genUlid0().toLowerCase();
}

function ulid(name?: string) {
  if (!name) {
    return text();
  } else {
    return text(name);
  }
}

/** JSON-serializable value, used for jsonb columns so server fns stay serializable. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const createdAt = timestamp('created_at').notNull().defaultNow();
const updatedAt = timestamp('updated_at')
  .notNull()
  .defaultNow()
  // use sql`now()` if https://github.com/drizzle-team/drizzle-orm/issues/2388 get fixed
  .$onUpdate(() => new Date());

/** ================== platform domain types ================== */

export type AppCapabilities = {
  database: boolean;
  frontend: boolean;
  widgets: boolean;
  backend: boolean;
  cron: boolean;
  webhook: boolean;
  /** Private persistent directory exposed only to the app backend. */
  storage?: boolean;
  /** Simple per-app key/value store (platform DB) for small tokens/config. */
  kv: boolean;
  /** Platform-managed typed tables with migrations and realtime queries. */
  dataTable?: boolean;
  /** Declares notification kinds and/or accepts routed notifications. */
  notifications?: boolean;
};

export type AppStatus =
  | 'draft'
  | 'building'
  | 'deployed'
  | 'failed'
  | 'archived';

export type DeploymentStatus = 'building' | 'deployed' | 'failed';

/** How an app cron job run was triggered. */
export type AppCronTrigger = 'scheduled' | 'manual';

/** ================== workflow domain types ================== */

export type WorkflowStatus =
  | 'draft'
  | 'building'
  | 'deployed'
  | 'failed'
  | 'archived';

export type WorkflowDeploymentStatus = 'building' | 'deployed' | 'failed';

/** How a workflow run was started. */
export type WorkflowTrigger = 'manual' | 'cron' | 'webhook';

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type WorkflowRunStepStatus = 'running' | 'succeeded' | 'failed';

/** Wire API the platform speaks to a provider with (mirrors pi-ai `model.api`). */
export type ProviderApiType =
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic-messages';

export type AgentRunStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AgentWorkspaceAffinityState = 'uninitialized' | 'claimed';

/** ================== apps ================== */

/**
 * An app is the unit AI Agent creates / maintains.
 *
 * `id` is an immutable internal key (a ULID for apps created after the
 * id/slug split; legacy apps keep their original kebab id). It keys the Git
 * repo, build artifacts, every `/api/app/<id>/...` runtime URL, and all FKs,
 * so it never changes once an app exists.
 *
 * `slug` is the mutable, unique, human-facing URL segment used in
 * `/app/<slug>`. Renaming it is cheap (no rebuild) because nothing technical
 * is keyed off it.
 */
export const apps = snakeCase.table(
  'apps',
  {
    id: text().primaryKey(),
    /** Mutable, unique URL slug for `/app/<slug>`. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: text().$type<AppStatus>().notNull().default('draft'),
    /** Capabilities of the current successful deployment; null before one exists. */
    capabilities: jsonb().$type<AppCapabilities>(),
    /** Manifest metadata for the current successful deployment; null before one exists. */
    manifest: jsonb().$type<JsonObject>(),
    /** Git bare repository path for this app's source. */
    repoPath: text(),
    /** Current commit of the authoritative master branch. */
    currentSourceCommit: text(),
    /** Backend mode of the current successful deployment; null before one exists. */
    backendMode: text().$type<'serverless' | 'long-running'>(),
    /**
     * Registered per-app Postgres database. Retained when the capability is
     * disabled, then cleared only after an explicit permanent deletion.
     */
    dbName: text(),
    /**
     * Versioned authenticated ciphertext for the per-app database password.
     * Never stores the plaintext credential.
     */
    dbPasswordCiphertext: text(),
    /** Reserved or provisioned platform-managed Postgres database name. */
    dataDbName: text(),
    /**
     * Versioned authenticated ciphertext for the managed Data Table database
     * password. Never stores the plaintext credential.
     */
    dataDbPasswordCiphertext: text(),
    /** Hash of the latest successfully applied managed Data Table schema. */
    dataSchemaHash: text(),
    /**
     * Deployment currently cutting over a managed Data Table schema. While set,
     * Data Table APIs fail closed until matching code has been activated.
     */
    dataActivationId: ulid(),
    /** Shared secret for verifying inbound webhook calls (webhook capability). */
    webhookSecret: text(),
    /**
     * Per-app HMAC key the platform uses to sign requests it makes INTO the
     * backend (cron RPC calls today; reused by authenticated webhooks/KV). The
     * backend gets it as `HATCH_SIGNING_SECRET` and verifies the signature so it
     * can trust a request originated from the platform. Generated on the first
     * deploy of a backend-capable app; never exposed to the browser.
     */
    signingSecret: text(),
    currentDeploymentId: ulid(),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('apps_slug_idx').on(table.slug)],
);

/** ================== deployments ================== */

export const deployments = snakeCase.table(
  'deployments',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    version: integer().notNull().default(1),
    /**
     * Platform runtime contract captured by a successful final deploy. Null
     * denotes legacy compatibility v1 so historical rows remain untouched.
     */
    compatibilityVersion: integer(),
    status: text().$type<DeploymentStatus>().notNull().default('building'),
    /**
     * Release note for this deployment. Required for new deploys (the Agent
     * supplies it via deploy_app); nullable so pre-existing rows stay empty
     * (not backfilled).
     */
    message: text(),
    /** Normalized manifest produced by the builder (deployed URLs etc). */
    manifestNormalized: jsonb().$type<JsonObject>(),
    /** Managed Data Table schema associated with this code deployment. */
    dataSchemaSnapshot: jsonb().$type<JsonObject>(),
    dataSchemaHash: text(),
    /** Generated migration plan applied for this deployment. */
    dataMigrationSummary: jsonb().$type<JsonObject>(),
    /** Commit deployed from the app's master branch. */
    sourceCommit: text(),
    /** Immutable deploy/v<version> Git tag for this deployment. */
    sourceTag: text(),
    /** Versioned filesystem artifact associated with sourceTag. */
    artifactPath: text(),
    buildLog: text(),
    error: text(),
    createdAt,
  },
  (table) => [
    // Version is allocated as max(version)+1 per app; enforce it at the DB so
    // overlapping deploys can't record the same version / force-move one tag.
    uniqueIndex('deployments_app_version_idx').on(table.appId, table.version),
  ],
);

/** ================== app cron runs ================== */

/**
 * History of app cron job invocations (both scheduled fires and manual "Run
 * now" triggers). One row per attempt, written by the scheduler after the call
 * completes, so the app's manage page can show a trigger history. Distinct from
 * `logs` (a free-text backend/agent log stream) — this is structured run data
 * (status, duration, trigger) mirroring `workflow_runs`.
 */
export const appCronRuns = snakeCase.table(
  'app_cron_runs',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** Cron job name as declared in the manifest. */
    jobName: text('job_name').notNull(),
    trigger: text().$type<AppCronTrigger>().notNull().default('scheduled'),
    /** HTTP status the backend returned, or null if the call threw first. */
    status: integer(),
    ok: boolean().notNull().default(false),
    /** Backend target invoked: an RPC `/service/Method` or a legacy raw path. */
    target: text(),
    /** Truncated response body (or error message) for quick diagnosis. */
    detail: text(),
    /** Wall-clock duration of the invocation in milliseconds. */
    durationMs: integer('duration_ms'),
    createdAt,
  },
  (table) => [
    // Listing is always "newest first for one app", so index that access path.
    index('app_cron_runs_app_created_idx').on(table.appId, table.createdAt),
  ],
);

/** ================== app key/value store ================== */

/**
 * A simple per-app key/value store kept in the PLATFORM database (not the app's
 * optional per-app Postgres), so an app can persist small bits of state — tokens,
 * config, counters — without provisioning the full database capability. Inspired
 * by Cloudflare Workers KV / Deno KV but deliberately minimal: no TTL/caching,
 * just durable string values keyed per app.
 *
 * Values are stored as text (the app serializes its own JSON). Secret values
 * use authenticated encryption when written; legacy secret rows may retain
 * plaintext until they are overwritten.
 */
export const appKv = snakeCase.table(
  'app_kv',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: text(),
    valueCiphertext: text('value_ciphertext'),
    /** When true, the manage UI masks the value (overwrite-only). */
    secret: boolean().notNull().default(false),
    createdAt,
    updatedAt,
  },
  (table) => [
    // One value per (app, key); also the lookup path for get/set/delete.
    uniqueIndex('app_kv_app_key_idx').on(table.appId, table.key),
    // Converted v2 snapshots retain explicit table qualification.
    check(
      'app_kv_value_storage_check',
      sql`(
        (not "app_kv"."secret" and "app_kv"."value" is not null and "app_kv"."value_ciphertext" is null)
        or
        ("app_kv"."secret" and (("app_kv"."value" is not null) <> ("app_kv"."value_ciphertext" is not null)))
      )`,
    ),
  ],
);

/** ================== workflows ================== */

/**
 * A workflow is a first-class, code-defined task the Agent authors. Unlike apps
 * it has no custom UI/API — the platform provides a fixed UI to trigger it
 * (manually, on a cron, or via webhook) and to audit its runs.
 *
 * `id` is an immutable internal key (a ULID for workflows created after the
 * id/slug split; legacy workflows keep their original kebab id). It keys the
 * Git repo, artifacts, runs, webhooks, manifests, and every foreign key.
 *
 * `slug` is the mutable, unique, human-facing URL segment used in
 * `/workflow/<slug>`. Renaming it does not rebuild or move technical state.
 */
export const workflows = snakeCase.table(
  'workflows',
  {
    id: text().primaryKey(),
    /** Mutable, unique URL slug for `/workflow/<slug>`. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: text().$type<WorkflowStatus>().notNull().default('draft'),
    /** Latest parsed source manifest (JSON from authored TS or JSON). */
    manifest: jsonb().$type<JsonObject>(),
    /**
     * JSON Schema (draft 2020-12) of the workflow input, derived from the
     * workflow's zod schema at deploy time and validated against before each run.
     */
    inputSchema: jsonb().$type<JsonObject>(),
    /** Git bare repository path for this workflow's source. */
    repoPath: text(),
    /** Current commit of the authoritative master branch. */
    currentSourceCommit: text(),
    currentDeploymentId: ulid(),
    /** Shared secret for verifying inbound webhook calls (webhook trigger). */
    webhookSecret: text(),
    /** Whether this workflow is pinned to the sidebar for quick access. */
    pinned: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex('workflows_slug_idx').on(table.slug)],
);

export const workflowDeployments = snakeCase.table(
  'workflow_deployments',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    workflowId: text()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version: integer().notNull().default(1),
    /** Compatibility contract explicitly selected by the source manifest. */
    compatibilityVersion: integer().notNull(),
    status: text()
      .$type<WorkflowDeploymentStatus>()
      .notNull()
      .default('building'),
    /** Release note for this deployment (required for new deploys). */
    message: text(),
    /** Normalized manifest produced by the builder (deployed webhook URL etc). */
    manifestNormalized: jsonb().$type<JsonObject>(),
    /** JSON Schema of the workflow input captured at build time. */
    inputSchema: jsonb().$type<JsonObject>(),
    /** Commit deployed from the workflow's master branch. */
    sourceCommit: text(),
    /** Immutable deploy/v<version> Git tag for this deployment. */
    sourceTag: text(),
    /** Versioned filesystem artifact (the bundled single-file program). */
    artifactPath: text(),
    buildLog: text(),
    error: text(),
    createdAt,
  },
  (table) => [
    // Same per-workflow version allocation as apps; enforce uniqueness at the DB.
    uniqueIndex('workflow_deployments_workflow_version_idx').on(
      table.workflowId,
      table.version,
    ),
  ],
);

/** ================== workflow runs ================== */

export const workflowRuns = snakeCase.table(
  'workflow_runs',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    workflowId: text()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** Deployment (version) this run executed. */
    deploymentId: ulid('deployment_id'),
    version: integer(),
    trigger: text().$type<WorkflowTrigger>().notNull(),
    status: text().$type<WorkflowRunStatus>().notNull().default('queued'),
    /** Validated input the run was started with. */
    input: jsonb().$type<JsonValue>(),
    /** Value returned by the workflow's run() on success. */
    output: jsonb().$type<JsonValue>(),
    error: text(),
    /** Captured stdout/stderr that wasn't part of the structured event stream. */
    log: text(),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt,
  },
  (table) => [
    // Run listings are always "newest first for one workflow" (plus the global
    // executions view sorted by createdAt); index the per-workflow access path
    // like app_cron_runs does.
    index('workflow_runs_workflow_created_idx').on(
      table.workflowId,
      table.createdAt,
    ),
  ],
);

export const workflowRunSteps = snakeCase.table(
  'workflow_run_steps',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    runId: ulid('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    name: text().notNull(),
    status: text().$type<WorkflowRunStepStatus>().notNull().default('running'),
    attempt: integer().notNull().default(1),
    output: jsonb().$type<JsonValue>(),
    error: text(),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt,
  },
  (table) => [
    // Keyed on attempt too so each retry of a step persists as its own row
    // (the run inspector renders every attempt); collapsing on (runId, seq)
    // would overwrite a failed attempt's error/timing with the next try.
    uniqueIndex('workflow_run_steps_run_seq_attempt_idx').on(
      table.runId,
      table.seq,
      table.attempt,
    ),
  ],
);

/** ================== agent providers / models ================== */

/**
 * LLM provider config. Configured from the platform UI (not env vars) so the
 * user can register multiple providers and pick per agent session.
 */
export const agentProviders = snakeCase.table('agent_providers', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  name: text().notNull(),
  apiType: text().$type<ProviderApiType>().notNull(),
  baseUrl: text().notNull(),
  apiKey: text().notNull(),
  enabled: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt,
  updatedAt,
});

export const agentModels = snakeCase.table('agent_models', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  providerId: ulid()
    .notNull()
    .references(() => agentProviders.id, { onDelete: 'cascade' }),
  /** Model id sent to the provider (e.g. "gpt-5.5"). */
  modelId: text().notNull(),
  name: text().notNull(),
  reasoning: boolean().notNull().default(false),
  contextWindow: integer().notNull().default(128000),
  maxTokens: integer().notNull().default(8192),
  enabled: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt,
});

/** ================== agent sessions ================== */

export const agentSessions = snakeCase.table(
  'agent_sessions',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    title: text().notNull().default('New chat'),
    providerId: ulid(),
    modelId: text(),
    /** Persisted pi `AgentMessage[]` (stored as JSON). */
    messages: jsonb().$type<JsonValue[]>().notNull().default([]),
    /** Runner whose local volume owns this session workspace and its `.env`. */
    workspaceRunnerId: text('workspace_runner_id'),
    /**
     * New sessions start `uninitialized`; an exact run.accepted or a hello
     * claim makes them `claimed` together with workspaceRunnerId. Migration
     * backfills the latest recorded Runner before any new dispatch can race.
     */
    workspaceAffinityState: text('workspace_affinity_state')
      .$type<AgentWorkspaceAffinityState>()
      .notNull()
      .default('uninitialized'),
    createdAt,
    updatedAt,
  },
  () => [
    // Converted v2 snapshots retain explicit table qualification.
    check(
      'agent_sessions_workspace_affinity_check',
      sql`(
        ("agent_sessions"."workspace_affinity_state" = 'claimed' and "agent_sessions"."workspace_runner_id" is not null)
        or
        ("agent_sessions"."workspace_affinity_state" = 'uninitialized' and "agent_sessions"."workspace_runner_id" is null)
      )`,
    ),
  ],
);

/** Apps whose source or deployment lifecycle this conversation edited. */
export const agentSessionApps = snakeCase.table(
  'agent_session_apps',
  {
    sessionId: ulid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.appId] }),
    index('agent_session_apps_app_session_idx').on(
      table.appId,
      table.sessionId,
    ),
  ],
);

export const agentAttachments = snakeCase.table(
  'agent_attachments',
  {
    id: text().primaryKey(),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    contentType: text('content_type').notNull(),
    size: integer().notNull(),
    /** Null while uploaded but not yet committed into a chat turn. */
    attachedAt: timestamp('attached_at'),
    createdAt,
  },
  (table) => [index('agent_attachments_session_idx').on(table.sessionId)],
);

export const agentRuns = snakeCase.table(
  'agent_runs',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    providerId: ulid('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    status: text().$type<AgentRunStatus>().notNull().default('running'),
    /**
     * The user input that started the run, stored for diagnostics/replay,
     * plus its `userTurn` binding to the transcript (`~agent/user-turns`).
     */
    input: jsonb().$type<JsonObject>().notNull(),
    /** The currently pending ask, if the run is blocked waiting for the user. */
    pendingAsk: jsonb('pending_ask').$type<JsonObject>(),
    /**
     * Answer accepted while the run's Agent Runner was briefly offline; the
     * hub delivers it when the runner reconnects and reclaims the run.
     */
    pendingAnswer: jsonb('pending_answer').$type<JsonObject>(),
    /**
     * Safe metadata for a pending environment request. Values are forwarded
     * directly to the Runner and are never stored in the platform database.
     */
    pendingEnvRequest: jsonb('pending_env_request').$type<JsonObject>(),
    /** Agent Runner executing this run (null before a runner accepted it). */
    runnerId: text('runner_id'),
    /**
     * Lease expiry for the executing runner. Renewed by runner heartbeats and
     * events; the sweeper interrupts active runs whose lease expired (runner
     * crashed or stayed disconnected past the grace window).
     */
    leaseExpiresAt: timestamp('lease_expires_at'),
    error: text(),
    completedAt: timestamp('completed_at'),
    /**
     * Consecutive failed runs in this session up to and including this run.
     * A completed run resets it to 0; a cancelled run carries the previous
     * value. Automatic retries stop once it exceeds the retry limit.
     */
    failureStreak: integer('failure_streak').notNull().default(0),
    /**
     * When the platform replays this failed run's turn automatically. Cleared
     * when the retry fires, the user stops it, or any newer run starts.
     */
    autoRetryAt: timestamp('auto_retry_at'),
    createdAt,
    updatedAt,
  },
  (table) => [
    // Converted v2 snapshots retain explicit table qualification.
    uniqueIndex('agent_runs_active_session_idx')
      .on(table.sessionId)
      .where(sql`"agent_runs"."status" in ('running', 'blocked')`),
    index('agent_runs_auto_retry_at_idx')
      .on(table.autoRetryAt)
      .where(sql`"agent_runs"."auto_retry_at" is not null`),
  ],
);

export const agentRunEvents = snakeCase.table(
  'agent_run_events',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    runId: ulid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    /**
     * Runner-assigned per-run sequence, used to dedupe events the runner
     * resends after a reconnect. Null for platform-originated events
     * (cancel/interrupt); Postgres treats NULLs as distinct in the unique
     * index, so those never collide.
     */
    runnerSeq: integer('runner_seq'),
    type: text().notNull(),
    payload: jsonb().$type<JsonObject>().notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('agent_run_events_run_seq_idx').on(table.runId, table.seq),
    uniqueIndex('agent_run_events_run_runner_seq_idx').on(
      table.runId,
      table.runnerSeq,
    ),
  ],
);

/** ================== dashboard & sidebar ================== */

/**
 * A dashboard is a named board the user arranges widgets on. Users can create
 * multiple dashboards; each owns its own set of widget placements.
 */
export const dashboards = snakeCase.table('dashboards', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  name: text().notNull(),
  /** Optional free-form subtitle shown in the dashboard page header. */
  description: text(),
  /** Whether this dashboard is pinned to the sidebar for quick access. */
  pinned: boolean().notNull().default(true),
  /**
   * Auto-refresh interval in seconds; 0 disables it. When > 0 the dashboard
   * periodically refreshes every widget (Grafana-style).
   */
  autoRefresh: integer('auto_refresh').notNull().default(0),
  /** Monotonic version for widget membership and breakpoint layout drafts. */
  editorRevision: integer('editor_revision').notNull().default(0),
  sortOrder: integer().notNull().default(0),
  createdAt,
  updatedAt,
});

export const dashboardBreakpoint = pgEnum('dashboard_breakpoint', [
  'desktop',
  'tablet',
  'mobile',
]);

export const dashboardWidgets = snakeCase.table(
  'dashboard_widgets',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    dashboardId: text()
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    /** Widget id as declared in the app manifest. */
    widgetId: text().notNull(),
    config: jsonb().$type<JsonObject>(),
    sortOrder: integer().notNull().default(0),
    createdAt,
  },
  (table) => [
    // One placement per (dashboard, app, widget): the add path returns an existing
    // row, so the DB must reject duplicate concurrent inserts.
    uniqueIndex('dashboard_widgets_dash_app_widget_idx').on(
      table.dashboardId,
      table.appId,
      table.widgetId,
    ),
  ],
);

export const dashboardWidgetLayouts = snakeCase.table(
  'dashboard_widget_layouts',
  {
    dashboardWidgetId: text('dashboard_widget_id')
      .notNull()
      .references(() => dashboardWidgets.id, { onDelete: 'cascade' }),
    breakpoint: dashboardBreakpoint().notNull(),
    x: integer().notNull().default(0),
    y: integer().notNull().default(0),
    w: integer().notNull().default(4),
    h: integer().notNull().default(3),
  },
  (table) => [
    primaryKey({ columns: [table.dashboardWidgetId, table.breakpoint] }),
  ],
);

export const sidebarItems = snakeCase.table(
  'sidebar_items',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    icon: text(),
    /**
     * Optional hash entry point into the app (apps use hash routing), stored as
     * the fragment without the leading '#', e.g. '/settings'. null/empty opens
     * the app root. Lets a pin deep-link to a specific page within the app.
     */
    entryHash: text(),
    sortOrder: integer().notNull().default(0),
    createdAt,
  },
  (table) => [
    // Apps may be pinned multiple times (each pin carries its own label and
    // entry hash), so this is a plain lookup index, not a unique constraint.
    index('sidebar_items_app_idx').on(table.appId),
  ],
);

/** ================== logs ================== */

export type LogSource =
  | 'agent'
  | 'build'
  | 'deploy'
  | 'backend'
  | 'webhook'
  | 'cron'
  | 'workflow';

export const logs = snakeCase.table('logs', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  appId: text(),
  source: text().$type<LogSource>().notNull(),
  level: text()
    .$type<'debug' | 'info' | 'warn' | 'error'>()
    .notNull()
    .default('info'),
  message: text().notNull(),
  data: jsonb().$type<JsonObject>(),
  createdAt,
});

/** ================== platform config ================== */

/**
 * Global, mutable platform settings as a small key/value store (e.g. whether
 * self-service sign-up is open). The DB layer keeps `value` as free-form
 * jsonb so new settings never need a migration; the application layer gates
 * every read/write through a typed, Zod-validated registry
 * (`~server/platform-config`), so this never becomes an arbitrary state bag.
 */
export const platformConfig = snakeCase.table('platform_config', {
  key: text().primaryKey(),
  value: jsonb().$type<JsonValue>().notNull(),
  updatedAt,
});

/** Personal account preferences; platform resources remain shared. */
export const userPreferences = snakeCase.table('user_preferences', {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  homepage: jsonb().$type<HomepageTarget>().notNull(),
  updatedAt,
});

/** ================== notifications ================== */

/** A notification kind declared by an App manifest or a Channel. */
export type NotificationKindDeclaration = {
  kind: string;
  name: string;
  description?: string;
};

export type NotificationSourceType = 'app' | 'channel' | 'platform';
export type NotificationRouteSourceType = 'app' | 'channel' | 'any';
export type NotificationDestinationType = 'device' | 'webhook' | 'app';
export type NotificationApnsEnvironment = 'sandbox' | 'production';
/**
 * Why a destination is disabled: `user` in settings (only settings re-enable
 * it), `device` turned push off on the phone (the phone re-enables it), or
 * `unregistered` by APNs (a new token revives it).
 */
export type NotificationDisabledReason = 'user' | 'device' | 'unregistered';
export type NotificationDeliveryStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed';

/**
 * External notification sources. Callers authenticate with a channel token
 * whose sha256 is stored here; the plaintext is shown once at creation.
 */
export const notificationChannels = snakeCase.table(
  'notification_channels',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    name: text().notNull(),
    description: text(),
    kinds: jsonb().$type<NotificationKindDeclaration[]>().notNull(),
    tokenHash: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('notification_channels_token_hash_idx').on(table.tokenHash),
  ],
);

/**
 * Every accepted notification. Source names and kind names are snapshots so
 * history stays readable after the App or Channel is renamed or removed.
 */
export const notifications = snakeCase.table(
  'notifications',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    sourceType: text().$type<NotificationSourceType>().notNull(),
    appId: text().references(() => apps.id, { onDelete: 'set null' }),
    channelId: ulid().references(() => notificationChannels.id, {
      onDelete: 'set null',
    }),
    sourceName: text().notNull(),
    kind: text().notNull(),
    kindName: text().notNull(),
    title: text().notNull(),
    body: text(),
    url: text(),
    data: jsonb().$type<JsonObject>(),
    dedupeKey: text(),
    occurredAt: timestamp('occurred_at').notNull(),
    createdAt,
  },
  (table) => [
    index('notifications_created_idx').on(table.createdAt),
    index('notifications_app_created_idx').on(table.appId, table.createdAt),
    index('notifications_channel_created_idx').on(
      table.channelId,
      table.createdAt,
    ),
    uniqueIndex('notifications_app_dedupe_idx')
      .on(table.appId, table.dedupeKey)
      .where(
        sql`"notifications"."app_id" is not null and "notifications"."dedupe_key" is not null`,
      ),
    uniqueIndex('notifications_channel_dedupe_idx')
      .on(table.channelId, table.dedupeKey)
      .where(
        sql`"notifications"."channel_id" is not null and "notifications"."dedupe_key" is not null`,
      ),
    check(
      'notifications_source_check',
      sql`(
        ("notifications"."source_type" = 'app' and "notifications"."channel_id" is null)
        or ("notifications"."source_type" = 'channel' and "notifications"."app_id" is null)
        or ("notifications"."source_type" = 'platform' and "notifications"."app_id" is null and "notifications"."channel_id" is null)
      )`,
    ),
  ],
);

/**
 * Where notifications can be delivered. A device is one signed-in mobile
 * session; a webhook is an outbound URL; an app is an App whose manifest
 * accepts routed notifications.
 */
export const notificationDestinations = snakeCase.table(
  'notification_destinations',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    type: text().$type<NotificationDestinationType>().notNull(),
    name: text().notNull(),
    enabled: boolean().notNull().default(true),
    sessionId: text().references(() => session.id, { onDelete: 'cascade' }),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    platform: text().$type<'ios'>(),
    apnsToken: text(),
    apnsEnvironment: text().$type<NotificationApnsEnvironment>(),
    e2eKeyId: text(),
    e2eKeyCiphertext: text(),
    url: text(),
    secretCiphertext: text(),
    appId: text().references(() => apps.id, { onDelete: 'cascade' }),
    /** Set while disabled: by a person, or by APNs rejecting the token. */
    disabledReason: text().$type<NotificationDisabledReason>(),
    /** Last provider/configuration error, kept for the settings UI. */
    lastError: text(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('notification_destinations_session_idx')
      .on(table.sessionId)
      .where(sql`"notification_destinations"."session_id" is not null`),
    uniqueIndex('notification_destinations_apns_token_idx')
      .on(table.apnsToken)
      .where(sql`"notification_destinations"."apns_token" is not null`),
    uniqueIndex('notification_destinations_app_idx')
      .on(table.appId)
      .where(sql`"notification_destinations"."app_id" is not null`),
    check(
      'notification_destinations_type_check',
      sql`(
        ("notification_destinations"."type" = 'device'
          and "notification_destinations"."session_id" is not null
          and "notification_destinations"."user_id" is not null
          and "notification_destinations"."platform" is not null
          and "notification_destinations"."apns_token" is not null
          and "notification_destinations"."apns_environment" is not null
          and "notification_destinations"."e2e_key_id" is not null
          and "notification_destinations"."e2e_key_ciphertext" is not null
          and "notification_destinations"."url" is null
          and "notification_destinations"."app_id" is null)
        or ("notification_destinations"."type" = 'webhook'
          and "notification_destinations"."url" is not null
          and "notification_destinations"."secret_ciphertext" is not null
          and "notification_destinations"."session_id" is null
          and "notification_destinations"."app_id" is null)
        or ("notification_destinations"."type" = 'app'
          and "notification_destinations"."app_id" is not null
          and "notification_destinations"."session_id" is null
          and "notification_destinations"."url" is null)
      )`,
    ),
  ],
);

export const notificationGroups = snakeCase.table('notification_groups', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  name: text().notNull(),
  description: text(),
  /**
   * Device destinations created later join this group on creation. Existing
   * members are untouched, and a removed device stays removed.
   */
  autoAddDevices: boolean().notNull().default(false),
  createdAt,
  updatedAt,
});

export const notificationGroupMembers = snakeCase.table(
  'notification_group_members',
  {
    groupId: ulid()
      .notNull()
      .references(() => notificationGroups.id, { onDelete: 'cascade' }),
    destinationId: ulid()
      .notNull()
      .references(() => notificationDestinations.id, { onDelete: 'cascade' }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.destinationId] }),
    index('notification_group_members_destination_idx').on(table.destinationId),
  ],
);

/**
 * Routing rule: notifications matching (source, kind) go to one group or one
 * destination. A null sourceId/kind matches any value.
 */
export const notificationRoutes = snakeCase.table(
  'notification_routes',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    name: text(),
    sourceType: text().$type<NotificationRouteSourceType>().notNull(),
    appId: text().references(() => apps.id, { onDelete: 'cascade' }),
    channelId: ulid().references(() => notificationChannels.id, {
      onDelete: 'cascade',
    }),
    kind: text(),
    targetGroupId: ulid().references(() => notificationGroups.id, {
      onDelete: 'cascade',
    }),
    targetDestinationId: ulid().references(() => notificationDestinations.id, {
      onDelete: 'cascade',
    }),
    enabled: boolean().notNull().default(true),
    createdAt,
    updatedAt,
  },
  () => [
    check(
      'notification_routes_target_check',
      sql`(("notification_routes"."target_group_id" is null) <> ("notification_routes"."target_destination_id" is null))`,
    ),
    check(
      'notification_routes_source_check',
      sql`(
        ("notification_routes"."source_type" = 'app' and "notification_routes"."channel_id" is null)
        or ("notification_routes"."source_type" = 'channel' and "notification_routes"."app_id" is null)
        or ("notification_routes"."source_type" = 'any' and "notification_routes"."app_id" is null and "notification_routes"."channel_id" is null)
      )`,
    ),
  ],
);

/** One delivery per (notification, destination), with durable retry state. */
export const notificationDeliveries = snakeCase.table(
  'notification_deliveries',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    notificationId: ulid()
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    destinationId: ulid().references(() => notificationDestinations.id, {
      onDelete: 'set null',
    }),
    destinationType: text().$type<NotificationDestinationType>().notNull(),
    destinationName: text().notNull(),
    status: text()
      .$type<NotificationDeliveryStatus>()
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at'),
    lastError: text(),
    httpStatus: integer(),
    /** Free-form string returned by an App destination; never interpreted. */
    result: text(),
    routeIds: jsonb().$type<string[]>().notNull(),
    completedAt: timestamp('completed_at'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('notification_deliveries_notification_destination_idx').on(
      table.notificationId,
      table.destinationId,
    ),
    index('notification_deliveries_due_idx')
      .on(table.status, table.nextAttemptAt)
      .where(
        sql`"notification_deliveries"."status" in ('pending', 'in_progress')`,
      ),
  ],
);
