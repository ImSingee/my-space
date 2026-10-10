import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type {
  CliScope,
  CredentialType,
  ResourceRange,
} from '../auth/cli-policy';

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const cliAuthLimits = pgTable('cli_auth_limits', {
  bucket: text('bucket').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: time('expires_at').notNull(),
});

/** Hatch bindings hold context, never a second key hash or copy of key permissions. */
export const cliAuthInstance = pgTable(
  'cli_auth_instance',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id').notNull().unique(),
    epoch: integer('epoch').notNull().default(1),
  },
  (t) => [check('cli_auth_single_instance', sql`${t.id} = 'platform'`)],
);

export const cliUserSecurity = pgTable('cli_user_security', {
  userId: text('user_id').primaryKey(),
  epoch: integer('epoch').notNull().default(1),
});

export const cliCredentialBindings = pgTable(
  'cli_credential_bindings',
  {
    keyId: text('key_id').primaryKey(),
    credentialType: text('credential_type').$type<CredentialType>().notNull(),
    userId: text('user_id').notNull(),
    userEpoch: integer('user_epoch').notNull(),
    instanceId: text('instance_id').notNull(),
    instanceEpoch: integer('instance_epoch').notNull(),
    resources: jsonb('resources').$type<ResourceRange>().notNull(),
    displayName: text('display_name').notNull(),
    issuedExpiresAt: time('issued_expires_at').notNull(),
    runId: text('run_id'),
    sessionId: text('session_id'),
    runnerId: text('runner_id'),
    runEpoch: integer('run_epoch'),
    createdAt: time('created_at').notNull().defaultNow(),
    revokedAt: time('revoked_at'),
  },
  (t) => [
    index('cli_bindings_user_idx').on(t.userId),
    index('cli_bindings_run_idx').on(t.runId),
    check(
      'cli_binding_context',
      sql`(${t.credentialType} IN ('interactive_key', 'user_api_key') AND ${t.runId} IS NULL AND ${t.sessionId} IS NULL AND ${t.runnerId} IS NULL AND ${t.runEpoch} IS NULL) OR (${t.credentialType} = 'run_key' AND ${t.runId} IS NOT NULL AND ${t.sessionId} IS NOT NULL AND ${t.runnerId} IS NOT NULL AND ${t.runEpoch} IS NOT NULL)`,
    ),
  ],
);

/** Immutable grant for a real Cookie-initiated run. Historical runs get no inferred issuer. */
export const cliRunAuthorizations = pgTable(
  'cli_run_authorizations',
  {
    runId: text('run_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    userId: text('user_id').notNull(),
    userEpoch: integer('user_epoch').notNull(),
    instanceId: text('instance_id').notNull(),
    instanceEpoch: integer('instance_epoch').notNull(),
    epoch: integer('epoch').notNull().default(1),
    scopes: jsonb('scopes').$type<CliScope[]>().notNull(),
    resources: jsonb('resources').$type<ResourceRange>().notNull(),
    revokedAt: time('revoked_at'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [index('cli_run_auth_user_idx').on(t.userId)],
);

/** No FKs: audit and revocation evidence survive user/run/plugin cleanup. */
export const cliAuthAudit = pgTable(
  'cli_auth_audit',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    userId: text('user_id'),
    credentialId: text('credential_id'),
    runId: text('run_id'),
    details: jsonb('details')
      .$type<Record<string, string | number | boolean | string[]>>()
      .notNull()
      .default({}),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [index('cli_audit_user_time_idx').on(t.userId, t.createdAt)],
);
