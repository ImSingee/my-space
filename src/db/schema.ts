import { sql } from 'drizzle-orm';
import {
  timestamp as _timestamp,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { ulid as genUlid0 } from 'ulid';

export * from './auth-schema';

/** ================== utils ================== */
function timestamp(name?: string) {
  if (!name) {
    return _timestamp({ withTimezone: true, mode: 'date' });
  }
  return _timestamp(name, { withTimezone: true, mode: 'date' });
}

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
  storage: boolean;
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

/** ================== apps ================== */

/**
 * An app is the unit AI Agent creates / maintains.
 *
 * `id` is an immutable internal key (a ULID for apps created after the
 * id/slug split; legacy apps keep their original kebab id). It keys the Git
 * repo, build artifacts, every `/api/apps/<id>/...` runtime URL, and all FKs,
 * so it never changes once an app exists.
 *
 * `slug` is the mutable, unique, human-facing URL segment used only in
 * `/app/<slug>/`. Renaming it is cheap (no rebuild) because nothing technical
 * is keyed off it.
 */
export const apps = pgTable(
  'apps',
  {
    id: text().primaryKey(),
    /** Mutable, unique URL slug used in the human-facing `/app/<slug>/` URL. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    status: text().$type<AppStatus>().notNull().default('draft'),
    capabilities: jsonb().$type<AppCapabilities>(),
    /** Latest source manifest.json (as authored by the Agent). */
    manifest: jsonb().$type<JsonObject>(),
    /** Git bare repository path for this app's source. */
    repoPath: text(),
    /** Current commit of the authoritative master branch. */
    currentSourceCommit: text(),
    backendMode: text().$type<'serverless' | 'long-running'>(),
    /** Provisioned per-app Postgres database name, when database capability is on. */
    dbName: text(),
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

export const deployments = pgTable(
  'deployments',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    version: integer().notNull().default(1),
    status: text().$type<DeploymentStatus>().notNull().default('building'),
    /**
     * Release note for this deployment. Required for new deploys (the Agent
     * supplies it via deploy_app); nullable so pre-existing rows stay empty
     * (not backfilled).
     */
    message: text(),
    /** Normalized manifest produced by the builder (deployed URLs etc). */
    manifestNormalized: jsonb().$type<JsonObject>(),
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
export const appCronRuns = pgTable(
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

/** ================== workflows ================== */

/**
 * A workflow is a first-class, code-defined task the Agent authors. Unlike apps
 * it has no custom UI/API — the platform provides a fixed UI to trigger it
 * (manually, on a cron, or via webhook) and to audit its runs. `id` is a
 * human-readable kebab-case slug used in URLs and the workflow's Git repo.
 */
export const workflows = pgTable('workflows', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  status: text().$type<WorkflowStatus>().notNull().default('draft'),
  /** Latest source manifest.json (as authored by the Agent). */
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
});

export const workflowDeployments = pgTable(
  'workflow_deployments',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    workflowId: text()
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    version: integer().notNull().default(1),
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

export const workflowRuns = pgTable('workflow_runs', {
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
});

export const workflowRunSteps = pgTable(
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
export const agentProviders = pgTable('agent_providers', {
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

export const agentModels = pgTable('agent_models', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  providerId: ulid()
    .notNull()
    .references(() => agentProviders.id, { onDelete: 'cascade' }),
  /** Model id sent to the provider (e.g. "gpt-5.5"). */
  modelId: text().notNull(),
  name: text().notNull(),
  reasoning: boolean().notNull().default(false),
  /** Supported input modalities, e.g. ["text"] or ["text","image"]. */
  input: jsonb().$type<string[]>().notNull().default(['text']),
  contextWindow: integer().notNull().default(128000),
  maxTokens: integer().notNull().default(8192),
  enabled: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt,
});

/** ================== agent sessions ================== */

export const agentSessions = pgTable('agent_sessions', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  title: text().notNull().default('New chat'),
  /** Optional app this conversation is scoped to. */
  appId: text().references(() => apps.id, { onDelete: 'set null' }),
  providerId: ulid(),
  modelId: text(),
  /** Persisted pi `AgentMessage[]` (stored as JSON). */
  messages: jsonb().$type<JsonValue[]>().notNull().default([]),
  createdAt,
  updatedAt,
});

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    sessionId: ulid('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    providerId: ulid('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    status: text().$type<AgentRunStatus>().notNull().default('running'),
    /** The user input that started the run, stored for diagnostics/replay. */
    input: jsonb().$type<JsonObject>().notNull(),
    /** The currently pending ask, if the run is blocked waiting for the user. */
    pendingAsk: jsonb('pending_ask').$type<JsonObject>(),
    error: text(),
    completedAt: timestamp('completed_at'),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('agent_runs_active_session_idx')
      .on(table.sessionId)
      .where(sql`${table.status} in ('running', 'blocked')`),
  ],
);

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    runId: ulid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    type: text().notNull(),
    payload: jsonb().$type<JsonObject>().notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('agent_run_events_run_seq_idx').on(table.runId, table.seq),
  ],
);

/** ================== dashboard & sidebar ================== */

/**
 * A dashboard is a named board the user arranges widgets on. Users can create
 * multiple dashboards; each owns its own set of widget placements.
 */
export const dashboards = pgTable('dashboards', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  name: text().notNull(),
  /** Optional free-form subtitle shown in the dashboard page header. */
  description: text(),
  /** Whether this dashboard is pinned to the sidebar for quick access. */
  pinned: boolean().notNull().default(true),
  sortOrder: integer().notNull().default(0),
  createdAt,
  updatedAt,
});

export const dashboardWidgets = pgTable(
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
    x: integer().notNull().default(0),
    y: integer().notNull().default(0),
    w: integer().notNull().default(4),
    h: integer().notNull().default(3),
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

export const sidebarItems = pgTable(
  'sidebar_items',
  {
    id: ulid().$defaultFn(genUlid).primaryKey(),
    appId: text()
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    icon: text(),
    sortOrder: integer().notNull().default(0),
    createdAt,
  },
  (table) => [
    // One sidebar pin per app: the pin path checks-then-inserts, so the DB must
    // reject duplicate concurrent pins.
    uniqueIndex('sidebar_items_app_idx').on(table.appId),
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

export const logs = pgTable('logs', {
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
