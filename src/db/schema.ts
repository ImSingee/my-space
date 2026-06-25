import {
  timestamp as _timestamp,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
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
  workflow: boolean;
};

export type AppStatus =
  | 'draft'
  | 'building'
  | 'deployed'
  | 'failed'
  | 'archived';

export type DeploymentStatus = 'building' | 'deployed' | 'failed';

/** Wire API the platform speaks to a provider with (mirrors pi-ai `model.api`). */
export type ProviderApiType =
  | 'openai-responses'
  | 'openai-completions'
  | 'anthropic-messages';

/** ================== apps ================== */

/**
 * An app is the unit AI Agent creates / maintains. `id` is the human readable
 * slug used in manifest.id and in deployed paths (`/apps/<id>/`).
 */
export const apps = pgTable('apps', {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  status: text().$type<AppStatus>().notNull().default('draft'),
  capabilities: jsonb().$type<AppCapabilities>(),
  /** Latest source manifest.json (as authored by the Agent). */
  manifest: jsonb().$type<JsonObject>(),
  backendMode: text().$type<'serverless' | 'long-running'>(),
  /** Provisioned per-app Postgres database name, when database capability is on. */
  dbName: text(),
  /** Shared secret for verifying inbound webhook calls (webhook capability). */
  webhookSecret: text(),
  currentDeploymentId: ulid(),
  createdAt,
  updatedAt,
});

/** ================== deployments ================== */

export const deployments = pgTable('deployments', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  appId: text()
    .notNull()
    .references(() => apps.id, { onDelete: 'cascade' }),
  version: integer().notNull().default(1),
  status: text().$type<DeploymentStatus>().notNull().default('building'),
  /** Normalized manifest produced by the builder (deployed URLs etc). */
  manifestNormalized: jsonb().$type<JsonObject>(),
  buildLog: text(),
  error: text(),
  createdAt,
});

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

export const dashboardWidgets = pgTable('dashboard_widgets', {
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
});

export const sidebarItems = pgTable('sidebar_items', {
  id: ulid().$defaultFn(genUlid).primaryKey(),
  appId: text()
    .notNull()
    .references(() => apps.id, { onDelete: 'cascade' }),
  label: text().notNull(),
  icon: text(),
  sortOrder: integer().notNull().default(0),
  createdAt,
});

/** ================== logs ================== */

export type LogSource =
  | 'agent'
  | 'build'
  | 'deploy'
  | 'backend'
  | 'webhook'
  | 'cron';

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
