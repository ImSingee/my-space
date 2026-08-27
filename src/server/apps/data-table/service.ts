/** Query, mutation, inspection, and validation for managed Data Tables. */
import { createHash } from 'node:crypto';
import pg, { type Client as PgClient, type ResultBuilder } from 'pg';
import postgres, { type TransactionSql } from 'postgres';
import { ulid } from 'ulid';
import { z } from 'zod';
import { db } from '~/db';
import type { JsonValue } from '~/db/schema';
import { AppError } from '~server/errors';
import { assertSupportedDeployment } from '../compatibility';
import { DATA_MIGRATION_LOCK_KEY } from './migrate';
import { resolveAppDataDatabaseUrl } from './provision';
import { parseDataRevision } from './revision';
import type { DataField, DataSchemaDescriptor, DataTable } from './schema';
import {
  isDataDefaultNow,
  isValidDataDateTime,
  normalizeDataDateTime,
  parseDataSchemaDescriptor,
} from './schema';

const QUERY_LIMIT_DEFAULT = 50;
const QUERY_LIMIT_MAX = 200;
const MUTATION_LIMIT_MAX = 100;
const DATA_STATEMENT_TIMEOUT_MS = 10_000;
export const DATA_AGENT_RESULT_MAX_CHARS = 60_000;
export const DATA_RAW_SQL_TIMEOUT_MIN_MS = 1_000;
export const DATA_RAW_SQL_TIMEOUT_MAX_MS = 1_800_000;
export const DATA_REQUEST_MAX_BYTES = 1_000_000;
const DATA_ROW_MAX_BYTES = 256 * 1024;
const CHANGE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CURSOR_NULL_ALIAS = '__hatch_cursor_order_is_null';
const RAW_SQL_CONFLICT_STATES = new Set(['23503', '23505', '23P01']);
const RAW_SQL_CLIENT_ERROR_CLASSES = new Set([
  '0A',
  '21',
  '22',
  '23',
  '42',
  '44',
]);

type DataServiceGlobal = typeof globalThis & {
  __hatchDataLastPrune?: Map<string, number>;
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const whereSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']),
  value: jsonValueSchema,
});

export const dataQueryRequestSchema = z.object({
  table: z.string().min(1),
  where: z.array(whereSchema).max(16).default([]),
  orderBy: z
    .object({
      field: z.string().min(1),
      direction: z.enum(['asc', 'desc']).default('asc'),
    })
    .optional(),
  cursor: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(QUERY_LIMIT_MAX)
    .default(QUERY_LIMIT_DEFAULT),
});

const mutationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('insert'),
    table: z.string().min(1),
    value: z.record(z.string(), jsonValueSchema),
  }),
  z.object({
    type: z.literal('patch'),
    table: z.string().min(1),
    id: z.string().min(1),
    value: z.record(z.string(), jsonValueSchema),
    unset: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    type: z.literal('increment'),
    table: z.string().min(1),
    id: z.string().min(1),
    field: z.string().min(1),
    amount: z.number().finite(),
  }),
  z.object({
    type: z.literal('delete'),
    table: z.string().min(1),
    id: z.string().min(1),
  }),
]);

export const dataMutationRequestSchema = z.object({
  operations: z.array(mutationSchema).min(1).max(MUTATION_LIMIT_MAX),
});

export type DataQueryRequest = z.infer<typeof dataQueryRequestSchema>;
export type DataMutationRequest = z.infer<typeof dataMutationRequestSchema>;
type SqlParam = string | number | boolean | null;

export type DataTableAccessOptions = {
  /** Deployment expected by the calling App bundle, when known. */
  expectedDeploymentId?: string;
};

export type DataQueryOptions = DataTableAccessOptions & {
  /** Approximate serialized item budget for Agent-facing pagination. */
  resultMaxChars?: number;
};

export type DataMutationOptions = DataTableAccessOptions & {
  /** Serialized result budget checked before the mutation commits. */
  resultMaxChars?: number;
};

export type DataQueryResult = {
  items: Record<string, JsonValue>[];
  cursor: string | null;
  revision: number;
  /** Present only when an explicit result budget omitted otherwise valid rows. */
  truncated?: boolean;
};

export type DataRawSqlResultSet = {
  command: string;
  count: number | null;
  rows: Array<Record<string, unknown>>;
};

export type DataRawSqlResult = {
  results: DataRawSqlResultSet[];
  truncated: boolean;
};

type DriverRawSqlResult = {
  command: string | null;
  rowCount: number | null;
  rows: Array<Record<string, unknown>>;
};

const dataCursorSchema = z
  .object({
    version: z.literal(1),
    queryFingerprint: z.string().length(43),
    orderField: z.string().min(1),
    direction: z.enum(['asc', 'desc']),
    value: jsonValueSchema,
    sqlNull: z.boolean(),
    id: z.string().min(1),
  })
  .strict();

type DataCursor = z.infer<typeof dataCursorSchema>;

const systemFields = {
  id: { kind: 'string', optional: false },
  createdAt: { kind: 'datetime', optional: false },
  updatedAt: { kind: 'datetime', optional: false },
} satisfies Record<string, DataField>;

function ownValue<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

async function openDataClient(id: string) {
  return postgres(await resolveAppDataDatabaseUrl(id), {
    max: 1,
    connection: { statement_timeout: DATA_STATEMENT_TIMEOUT_MS },
  });
}

function qi(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableSql(name: string): string {
  return `${qi('data')}.${qi(name)}`;
}

function physicalField(name: string): string {
  if (name === 'createdAt') return 'created_at';
  if (name === 'updatedAt') return 'updated_at';
  return name;
}

function publicField(name: string): string {
  if (name === 'created_at') return 'createdAt';
  if (name === 'updated_at') return 'updatedAt';
  return name;
}

function tableFromSchema(
  schema: DataSchemaDescriptor,
  name: string,
): DataTable {
  const table = ownValue(schema.tables, name);
  if (!table) throw new AppError(`Unknown Data Table "${name}".`, 400);
  return table;
}

function fieldFromTable(table: DataTable, name: string): DataField | null {
  if (Object.hasOwn(systemFields, name)) return null;
  const field = ownValue(table.fields, name);
  if (!field) throw new AppError(`Unknown Data Table field "${name}".`, 400);
  return field;
}

function queryFieldFromTable(table: DataTable, name: string): DataField {
  return ownValue(systemFields, name) ?? fieldFromTable(table, name)!;
}

function validateFieldValue(field: DataField, value: JsonValue): void {
  if (value === null) {
    // A top-level JSON null is a real JSON value, not SQL NULL. Optional JSON
    // fields use SQL NULL only when the field is omitted from an insert.
    if (field.kind === 'json') return;
    if (!field.optional)
      throw new AppError('Required field cannot be null.', 400);
    return;
  }
  const valid = (() => {
    switch (field.kind) {
      case 'string':
      case 'reference':
      case 'datetime':
        return typeof value === 'string';
      case 'enum':
        return typeof value === 'string' && field.enumValues?.includes(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'json':
        return true;
    }
  })();
  if (!valid) throw new AppError(`Invalid ${field.kind} field value.`, 400);
  if (field.kind === 'datetime' && !isValidDataDateTime(value)) {
    throw new AppError('Invalid datetime field value.', 400);
  }
}

function defaultValue(field: DataField): JsonValue | undefined {
  if (field.default === undefined) return undefined;
  if (field.kind === 'datetime' && isDataDefaultNow(field.default)) {
    return new Date().toISOString();
  }
  return field.default as JsonValue;
}

function parameterExpression(field: DataField | null, index: number): string {
  if (field?.kind === 'json') {
    // parameterValue produces JSON text. Binding it as text prevents postgres.js
    // from applying its jsonb serializer and encoding that text a second time.
    return `$${index}::text::jsonb`;
  }
  if (field?.kind === 'datetime') return `$${index}::timestamptz`;
  return `$${index}`;
}

function parameterValue(field: DataField | null, value: JsonValue): SqlParam {
  if (field?.kind === 'json') return JSON.stringify(value);
  if (value === null) return null;
  if (field?.kind === 'datetime') {
    return normalizeDataDateTime(value as string);
  }
  return value as SqlParam;
}

function serializeRow(row: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      publicField(key),
      value instanceof Date ? value.toISOString() : (value as JsonValue),
    ]),
  );
}

function assertRowSize(row: Record<string, JsonValue>): void {
  if (Buffer.byteLength(JSON.stringify(row), 'utf8') > DATA_ROW_MAX_BYTES) {
    throw new AppError(
      `Data Table row exceeds ${DATA_ROW_MAX_BYTES} bytes.`,
      413,
    );
  }
}

function serializeStoredRow(
  row: Record<string, unknown>,
): Record<string, JsonValue> {
  const serialized = serializeRow(row);
  assertRowSize(serialized);
  return serialized;
}

function stableQueryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableQueryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableQueryValue(child)]),
    );
  }
  return value;
}

function dataQueryFingerprint(id: string, query: DataQueryRequest): string {
  const identity = {
    appId: id,
    table: query.table,
    where: query.where,
    orderBy: {
      field: query.orderBy?.field ?? 'id',
      direction: query.orderBy?.direction ?? 'asc',
    },
  };
  return createHash('sha256')
    .update(JSON.stringify(stableQueryValue(identity)))
    .digest('base64url');
}

function decodeCursor(
  encoded: string | undefined,
  queryFingerprint: string,
  orderField: string,
  direction: 'asc' | 'desc',
): DataCursor | null {
  if (!encoded) return null;
  try {
    const cursor = dataCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
    if (
      cursor.queryFingerprint !== queryFingerprint ||
      cursor.orderField !== orderField ||
      cursor.direction !== direction
    ) {
      throw new Error('cursor does not match query');
    }
    return cursor;
  } catch {
    throw new AppError('Invalid Data Table cursor.', 400);
  }
}

function cursorValue(value: unknown): JsonValue {
  return value instanceof Date ? value.toISOString() : (value as JsonValue);
}

function encodeCursor(
  row: Record<string, unknown>,
  queryFingerprint: string,
  orderField: string,
  direction: 'asc' | 'desc',
): string {
  const id = row.id;
  if (typeof id !== 'string') {
    throw new AppError('Data Table query returned an invalid row id.', 500);
  }
  const cursor = dataCursorSchema.parse({
    version: 1,
    queryFingerprint,
    orderField,
    direction,
    value: cursorValue(row[physicalField(orderField)]),
    sqlNull: row[CURSOR_NULL_ALIAS] === true,
    id,
  });
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

type DataReadGuardClient = TransactionSql | Pick<PgClient, 'query'>;

async function acquireReadLock(tx: DataReadGuardClient): Promise<void> {
  const ok =
    typeof tx === 'function'
      ? (
          await tx<{ ok: boolean }[]>`
            select pg_try_advisory_xact_lock_shared(${DATA_MIGRATION_LOCK_KEY}) as ok
          `
        )[0]?.ok
      : (
          await tx.query<{ ok: boolean }>(
            'select pg_try_advisory_xact_lock_shared($1) as ok',
            [DATA_MIGRATION_LOCK_KEY],
          )
        ).rows[0]?.ok;
  if (!ok) {
    throw new AppError(
      'Data Table migration is in progress. Retry shortly.',
      503,
    );
  }
}

async function assertCurrentAppState(
  id: string,
  options: DataTableAccessOptions,
): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      dataActivationId: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.dataTable
  ) {
    throw new AppError('Data Table is not available.', 404);
  }
  if (app.dataActivationId) {
    throw new AppError('Data Table deployment is being finalized.', 503);
  }
  if (
    options.expectedDeploymentId &&
    app.currentDeploymentId !== options.expectedDeploymentId
  ) {
    throw new AppError(
      'Data Table client is stale. Reload the App before retrying.',
      409,
    );
  }
  if (options.expectedDeploymentId) {
    await assertSupportedDeployment(app.currentDeploymentId);
  }
}

/**
 * Check only durable platform state, without first opening the App Data DB.
 * Realtime uses this before replay so archive/delete can close a stream even
 * after its LISTEN connection has been terminated by database cleanup. The
 * guarded transaction still repeats the check after taking the migration lock.
 */
export async function assertDataTableAccess(
  id: string,
  options: DataTableAccessOptions,
): Promise<void> {
  await assertCurrentAppState(id, options);
}

/**
 * Fence one short Data DB transaction against schema cutover, then verify that
 * the calling bundle still belongs to the active platform deployment.
 *
 * Realtime replay uses the same guard as ordinary queries. Keep this scoped to
 * an individual replay transaction; an SSE connection must never retain the
 * shared migration lock for its full lifetime.
 */
export async function acquireDataReadGuard(
  tx: DataReadGuardClient,
  id: string,
  options: DataTableAccessOptions,
): Promise<void> {
  // Lock before reading the platform fence. If a deploy commits its fence just
  // after this check, its exclusive migration lock still waits for this
  // transaction, so the request finishes against the schema observed here.
  await acquireReadLock(tx);
  await assertDataTableAccess(id, options);
}

async function schemaInTransaction(
  tx: TransactionSql,
): Promise<DataSchemaDescriptor> {
  const [row] = await tx<{ schema_snapshot: unknown }[]>`
    select schema_snapshot from _hatch.migrations order by id desc limit 1
  `;
  if (!row) throw new AppError('Data Table schema is not deployed.', 409);
  return parseDataSchemaDescriptor(row.schema_snapshot);
}

function compileQuery(
  schema: DataSchemaDescriptor,
  query: DataQueryRequest,
  queryFingerprint: string,
) {
  const table = tableFromSchema(schema, query.table);
  const orderField = query.orderBy?.field ?? 'id';
  queryFieldFromTable(table, orderField);
  const params: SqlParam[] = [];
  const clauses: string[] = [];
  for (const condition of query.where) {
    const field = queryFieldFromTable(table, condition.field);
    const column = qi(physicalField(condition.field));
    if (condition.op === 'in') {
      if (!Array.isArray(condition.value) || condition.value.length === 0) {
        throw new AppError('The in operator requires a non-empty array.', 400);
      }
      const values = condition.value.map((value) => {
        if (value === null) {
          throw new AppError('The in operator does not accept null.', 400);
        }
        validateFieldValue(field, value);
        params.push(parameterValue(field, value));
        return parameterExpression(field, params.length);
      });
      clauses.push(`${column} in (${values.join(', ')})`);
      continue;
    }
    if (condition.value === null) {
      if (condition.op !== 'eq' && condition.op !== 'ne') {
        throw new AppError('Only eq/ne can compare a field with null.', 400);
      }
      if (field.kind === 'json') {
        params.push(parameterValue(field, null));
        const jsonNull = parameterExpression(field, params.length);
        if (!field.optional) {
          clauses.push(
            `${column} ${condition.op === 'eq' ? '=' : '<>'} ${jsonNull}`,
          );
          continue;
        }
        clauses.push(
          condition.op === 'eq'
            ? `(${column} is null or ${column} is not distinct from ${jsonNull})`
            : `(${column} is not null and ${column} is distinct from ${jsonNull})`,
        );
        continue;
      }
      validateFieldValue(field, null);
      clauses.push(`${column} is ${condition.op === 'ne' ? 'not ' : ''}null`);
      continue;
    }
    validateFieldValue(field, condition.value);
    params.push(parameterValue(field, condition.value));
    const operators = {
      eq: '=',
      ne: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    } as const;
    clauses.push(
      `${column} ${operators[condition.op]} ${parameterExpression(
        field,
        params.length,
      )}`,
    );
  }

  const orderColumn = qi(physicalField(orderField));
  const orderDirection = query.orderBy?.direction ?? 'asc';
  const cursor = decodeCursor(
    query.cursor,
    queryFingerprint,
    orderField,
    orderDirection,
  );
  if (cursor) {
    const comparison = orderDirection === 'asc' ? '>' : '<';
    if (orderField === 'id') {
      params.push(cursor.id);
      clauses.push(`${qi('id')} ${comparison} $${params.length}`);
    } else if (cursor.sqlNull) {
      if (!queryFieldFromTable(table, orderField).optional) {
        throw new AppError('Invalid Data Table cursor.', 400);
      }
      params.push(cursor.id);
      const withinNulls =
        `${orderColumn} is null and ` +
        `${qi('id')} ${comparison} $${params.length}`;
      clauses.push(
        orderDirection === 'asc'
          ? `(${withinNulls})`
          : `(${orderColumn} is not null or (${withinNulls}))`,
      );
    } else {
      const field = queryFieldFromTable(table, orderField);
      if (cursor.value === null && field.kind !== 'json') {
        throw new AppError('Invalid Data Table cursor.', 400);
      }
      validateFieldValue(field, cursor.value);
      params.push(parameterValue(field, cursor.value));
      const value = parameterExpression(field, params.length);
      params.push(cursor.id);
      const sameValue =
        `${orderColumn} is not distinct from ${value} and ` +
        `${qi('id')} ${comparison} $${params.length}`;
      const after = `${orderColumn} ${comparison} ${value} or (${sameValue})`;
      clauses.push(
        orderDirection === 'asc'
          ? `(${after} or ${orderColumn} is null)`
          : `(${after})`,
      );
    }
  }
  params.push(query.limit + 1);
  const statement =
    `select *, ${orderColumn} is null as ${qi(CURSOR_NULL_ALIAS)} ` +
    `from ${tableSql(query.table)}` +
    (clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '') +
    ` order by ${orderColumn} ${orderDirection}` +
    (orderField === 'id' ? ' ' : `, ${qi('id')} ${orderDirection} `) +
    `limit $${params.length}`;
  return { statement, params, orderField, orderDirection };
}

export async function queryDataTable(
  id: string,
  input: unknown,
  options: DataQueryOptions = {},
): Promise<DataQueryResult> {
  const query = dataQueryRequestSchema.parse(input);
  const queryFingerprint = dataQueryFingerprint(id, query);
  const sql = await openDataClient(id);
  try {
    return await sql.begin('isolation level repeatable read', async (tx) => {
      await acquireDataReadGuard(tx, id, options);
      const schema = await schemaInTransaction(tx);
      const { statement, params, orderField, orderDirection } = compileQuery(
        schema,
        query,
        queryFingerprint,
      );
      const rows = await tx.unsafe<Record<string, unknown>[]>(
        statement,
        params,
      );
      const page = rows.slice(0, query.limit);
      const databaseHasMore = rows.length > query.limit;
      let includedRows = page;
      let items = page.map((row) => {
        const { [CURSOR_NULL_ALIAS]: _cursorNull, ...stored } = row;
        return serializeStoredRow(stored);
      });
      let budgetTruncated = false;
      if (options.resultMaxChars !== undefined) {
        const resultSize = (
          candidateItems: Record<string, JsonValue>[],
          candidateRows: Record<string, unknown>[],
          more: boolean,
        ) =>
          JSON.stringify(
            {
              items: candidateItems,
              cursor: more
                ? encodeCursor(
                    candidateRows.at(-1)!,
                    queryFingerprint,
                    orderField,
                    orderDirection,
                  )
                : null,
              revision: Number.MAX_SAFE_INTEGER,
              truncated: more && !databaseHasMore,
            },
            null,
            2,
          ).length;

        if (
          resultSize(items, includedRows, databaseHasMore) >
          options.resultMaxChars
        ) {
          let best = 0;
          for (let count = 1; count <= page.length; count++) {
            const candidateItems = items.slice(0, count);
            const candidateRows = page.slice(0, count);
            // Item bytes only grow with the prefix. Once they cannot fit even
            // without a cursor, no longer prefix can fit either. Cursor size
            // itself is not monotonic because each row's sort value differs.
            if (
              resultSize(candidateItems, candidateRows, false) >
              options.resultMaxChars
            ) {
              break;
            }
            if (
              resultSize(candidateItems, candidateRows, true) <=
              options.resultMaxChars
            ) {
              best = count;
            }
          }
          if (best === 0) {
            throw new AppError(
              'A complete Data Table record and its pagination cursor exceed ' +
                'the Agent output budget. Use raw_sql to select narrower ' +
                'columns or substring large values.',
              413,
            );
          }
          includedRows = page.slice(0, best);
          items = items.slice(0, best);
          budgetTruncated = best < page.length;
        }
      }
      const more = databaseHasMore || budgetTruncated;
      const [revisionRow] = await tx<{ revision: string }[]>`
        select coalesce(max(seq), 0)::text as revision from _hatch.changes
      `;
      return {
        items,
        cursor: more
          ? encodeCursor(
              includedRows.at(-1)!,
              queryFingerprint,
              orderField,
              orderDirection,
            )
          : null,
        revision: parseDataRevision(revisionRow?.revision ?? '0'),
        ...(options.resultMaxChars === undefined
          ? {}
          : { truncated: budgetTruncated }),
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const RAW_SQL_ROW_LIMIT = 100;
const RAW_SQL_PREVIEW_FIELD = '__hatch_preview';
const RAW_SQL_PREVIEW_NOTICE_FIELD = '__hatch_preview_notice';
const RAW_SQL_PREVIEW_NOTICE =
  'This row exceeded the raw SQL output budget. The preview is incomplete; ' +
  'rerun with narrower columns, LIMIT, keyset conditions, or SQL substring functions.';

function normalizeRawSqlValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString('hex')}`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const normalized = value.map((child) => normalizeRawSqlValue(child, seen));
    seen.delete(value);
    return normalized;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeRawSqlValue(child, seen),
      ]),
    );
    seen.delete(value);
    return normalized;
  }
  return value === undefined ? null : String(value);
}

function normalizeRawSqlRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      normalizeRawSqlValue(value, new WeakSet()),
    ]),
  );
}

function splitDriverResults(
  value: DriverRawSqlResult | DriverRawSqlResult[],
): DriverRawSqlResult[] {
  return Array.isArray(value) ? value : [value];
}

function fitsRawSqlBudget(
  results: DataRawSqlResultSet[],
  maxChars: number,
): boolean {
  return JSON.stringify(results, null, 2).length <= maxChars;
}

function addRawSqlRowPreview(
  results: DataRawSqlResultSet[],
  target: DataRawSqlResultSet,
  row: Record<string, unknown>,
  maxChars: number,
): void {
  const encoded = JSON.stringify(row);
  let low = 0;
  let high = Math.min(encoded.length, maxChars);
  let best: Record<string, unknown> | null = null;

  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = {
      [RAW_SQL_PREVIEW_FIELD]: `${encoded.slice(0, length)}${
        length < encoded.length ? '…' : ''
      }`,
      [RAW_SQL_PREVIEW_NOTICE_FIELD]: RAW_SQL_PREVIEW_NOTICE,
    };
    target.rows.push(candidate);
    const fits = fitsRawSqlBudget(results, maxChars);
    target.rows.pop();
    if (fits) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (best) target.rows.push(best);
}

function addExistingRawSqlRowPreview(
  results: DataRawSqlResultSet[],
  target: DataRawSqlResultSet,
  row: Record<string, unknown>,
  maxChars: number,
): boolean {
  const preview = row[RAW_SQL_PREVIEW_FIELD];
  if (
    typeof preview !== 'string' ||
    row[RAW_SQL_PREVIEW_NOTICE_FIELD] !== RAW_SQL_PREVIEW_NOTICE
  ) {
    return false;
  }

  let low = 0;
  let high = preview.length;
  let best: Record<string, unknown> | null = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = {
      [RAW_SQL_PREVIEW_FIELD]: `${preview.slice(0, length)}${
        length < preview.length ? '…' : ''
      }`,
      [RAW_SQL_PREVIEW_NOTICE_FIELD]: RAW_SQL_PREVIEW_NOTICE,
    };
    target.rows.push(candidate);
    const fits = fitsRawSqlBudget(results, maxChars);
    target.rows.pop();
    if (fits) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (best) target.rows.push(best);
  return true;
}

function presentRawSqlResults(
  raw: DriverRawSqlResult | DriverRawSqlResult[],
  maxChars = DATA_AGENT_RESULT_MAX_CHARS,
): DataRawSqlResult {
  const source = splitDriverResults(raw);
  const results: DataRawSqlResultSet[] = [];
  let emittedRows = 0;
  let truncated = false;
  let outputBudgetReached = false;

  for (let resultIndex = 0; resultIndex < source.length; resultIndex++) {
    const driverResult = source[resultIndex];
    const result: DataRawSqlResultSet = {
      command: driverResult.command ?? '',
      count: driverResult.rowCount,
      rows: [],
    };
    results.push(result);
    if (!fitsRawSqlBudget(results, maxChars)) {
      results.pop();
      truncated = true;
      break;
    }

    if (outputBudgetReached) {
      if (driverResult.rows.length > 0) truncated = true;
      continue;
    }

    for (let rowIndex = 0; rowIndex < driverResult.rows.length; rowIndex++) {
      if (emittedRows >= RAW_SQL_ROW_LIMIT) {
        truncated = true;
        break;
      }
      const row = normalizeRawSqlRow(driverResult.rows[rowIndex]);
      result.rows.push(row);
      if (!fitsRawSqlBudget(results, maxChars)) {
        result.rows.pop();
        truncated = true;
        if (emittedRows === 0) {
          if (!addExistingRawSqlRowPreview(results, result, row, maxChars)) {
            addRawSqlRowPreview(results, result, row, maxChars);
          }
        }
        outputBudgetReached = true;
        break;
      }
      emittedRows++;
    }
  }

  return { results, truncated };
}

function executeBoundedRawSql(
  client: PgClient,
  statement: string,
): Promise<DataRawSqlResult> {
  return new Promise((resolve, reject) => {
    const query = new pg.Query<Record<string, unknown>>(statement);
    const sourceRows = new Map<
      ResultBuilder<Record<string, unknown>>,
      Record<string, unknown>[]
    >();
    let emittedRows = 0;
    let outputBudgetReached = false;
    let rowLimitReached = false;
    let rowProcessingFailed = false;
    let rowProcessingError: unknown;

    query.on('row', (row, result) => {
      if (!result || outputBudgetReached || rowProcessingFailed) {
        return;
      }
      try {
        if (emittedRows >= RAW_SQL_ROW_LIMIT) {
          rowLimitReached = true;
          return;
        }
        const normalized = normalizeRawSqlRow(row);
        const existing = sourceRows.get(result) ?? [];
        const projected = [...sourceRows.entries()].map(([candidate, rows]) =>
          candidate === result ? [...existing, normalized] : rows,
        );
        if (!sourceRows.has(result)) projected.push([normalized]);
        const projectedSets = projected.map((rows) => ({
          command: '',
          count: null,
          rows,
        }));
        if (fitsRawSqlBudget(projectedSets, DATA_AGENT_RESULT_MAX_CHARS)) {
          existing.push(normalized);
          sourceRows.set(result, existing);
          emittedRows++;
        } else if (emittedRows === 0) {
          const previewTarget: DataRawSqlResultSet = {
            command: '',
            count: null,
            rows: [],
          };
          addRawSqlRowPreview(
            [previewTarget],
            previewTarget,
            normalized,
            DATA_AGENT_RESULT_MAX_CHARS,
          );
          sourceRows.set(result, previewTarget.rows);
          emittedRows++;
          outputBudgetReached = true;
        } else {
          outputBudgetReached = true;
        }
      } catch (error) {
        // A row event runs inside node-postgres' socket event stack. Never let
        // normalization or budget failures escape that callback: consume the
        // protocol, then reject so the surrounding transaction can roll back.
        rowProcessingFailed = true;
        rowProcessingError = error;
      }
    });
    query.once('error', reject);
    query.once('end', (raw) => {
      if (rowProcessingFailed) {
        reject(rowProcessingError);
        return;
      }
      try {
        const source = (Array.isArray(raw) ? raw : [raw]).map((result) => ({
          command: result.command || null,
          rowCount: result.rowCount,
          rows: sourceRows.get(result) ?? [],
        }));
        const presented = presentRawSqlResults(source);
        resolve({
          ...presented,
          truncated:
            presented.truncated || outputBudgetReached || rowLimitReached,
        });
      } catch (error) {
        reject(error);
      }
    });
    client.query(query);
  });
}

function rawSqlConnectionString(
  url: string,
  options: { disableSsl?: boolean } = {},
): string {
  const parsed = new URL(url);
  if (options.disableSsl) {
    parsed.searchParams.set('sslmode', 'disable');
    parsed.searchParams.delete('uselibpqcompat');
    return parsed.toString();
  }
  if (parsed.searchParams.get('sslrootcert') === 'system') {
    // postgres.js treats this libpq sentinel as the host trust store. pg's
    // connection-string parser instead interprets it as a filename, so omit
    // the sentinel and retain certificate + hostname verification explicitly.
    parsed.searchParams.delete('sslrootcert');
    parsed.searchParams.set('sslmode', 'verify-full');
    parsed.searchParams.delete('uselibpqcompat');
    return parsed.toString();
  }
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode && ['allow', 'prefer', 'require'].includes(sslMode)) {
    // postgres.js enables TLS without certificate verification for these
    // modes. pg's no-verify spelling preserves that behavior even when the
    // URL also carries a root certificate. sslmode=prefer gets an explicit
    // plaintext retry below when the server reports no TLS support.
    parsed.searchParams.set('sslmode', 'no-verify');
    parsed.searchParams.delete('uselibpqcompat');
  }
  return parsed.toString();
}

function rawSqlTlsPreference(url: string): 'prefer' | 'fixed' {
  const params = new URL(url).searchParams;
  return params.get('sslrootcert') !== 'system' &&
    params.get('sslmode') === 'prefer'
    ? 'prefer'
    : 'fixed';
}

function rawSqlServerHasNoTls(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'The server does not support SSL connections'
  );
}

function rawSqlAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function rawSqlTimeoutError(timeoutMs: number): AppError {
  return new AppError(
    `Raw Data Table SQL timed out after ${timeoutMs} milliseconds.`,
    504,
  );
}

function rawSqlOutcomeUnknownError(cause: unknown): AppError {
  const error = new AppError(
    'Raw SQL transaction outcome is unknown. PostgreSQL may have committed ' +
      'the changes before the connection was lost. Do not retry this SQL ' +
      'automatically; inspect the affected data first.',
    409,
  );
  error.cause = cause;
  return error;
}

function boundedRawSqlError(error: unknown): Error {
  if (error instanceof AppError || error instanceof DOMException) return error;
  if (!(error instanceof Error)) {
    return new AppError('Raw Data Table SQL failed.', 500);
  }
  const code = (error as { code?: unknown }).code;
  const sqlState =
    typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const prefix = sqlState ? `PostgreSQL ${sqlState}: ` : '';
  const maxMessageChars = 4_000;
  const available = Math.max(0, maxMessageChars - prefix.length);
  const message =
    error.message.length <= available
      ? error.message
      : `${error.message.slice(0, Math.max(0, available - 1))}…`;
  const status = sqlState
    ? RAW_SQL_CONFLICT_STATES.has(sqlState)
      ? 409
      : RAW_SQL_CLIENT_ERROR_CLASSES.has(sqlState.slice(0, 2))
        ? 400
        : 500
    : 500;
  const bounded = new AppError(`${prefix}${message}`, status);
  bounded.cause = error;
  return bounded;
}

/**
 * Run Agent-issued SQL against the managed Data DB. Agent instructions limit
 * this escape hatch to querying or changing existing row data; deliberately do
 * not parse or reject SQL here, so the statement is forwarded verbatim and may
 * use PostgreSQL's simple-protocol multi-statement support.
 */
export async function executeDataTableRawSql(
  id: string,
  statement: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DataRawSqlResult> {
  if (statement.trim().length === 0) {
    throw new AppError('Raw Data Table SQL must not be blank.', 400);
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < DATA_RAW_SQL_TIMEOUT_MIN_MS ||
    timeoutMs > DATA_RAW_SQL_TIMEOUT_MAX_MS
  ) {
    throw new AppError(
      `Raw Data Table SQL timeout must be between ${DATA_RAW_SQL_TIMEOUT_MIN_MS} and ${DATA_RAW_SQL_TIMEOUT_MAX_MS} milliseconds.`,
      400,
    );
  }
  if (signal?.aborted) throw rawSqlAbortError(signal);

  const deadline = Date.now() + timeoutMs;
  let client: PgClient | undefined;
  let clientEndPromise: Promise<void> | undefined;
  let commitPhase: 'before_commit' | 'commit_in_flight' | 'commit_confirmed' =
    'before_commit';
  let stopError: Error | null = null;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const endClient = (): Promise<void> => {
    if (!client) return Promise.resolve();
    clientEndPromise ??= client.end().catch(() => {});
    return clientEndPromise;
  };
  const stop = (error: Error) => {
    if (stopError || commitPhase === 'commit_confirmed') return;
    stopError =
      commitPhase === 'commit_in_flight'
        ? rawSqlOutcomeUnknownError(error)
        : error;
    void endClient();
    rejectStop(stopError);
  };
  const timer = setTimeout(() => {
    stop(rawSqlTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => stop(rawSqlAbortError(signal!));
  signal?.addEventListener('abort', onAbort, { once: true });

  const execute = async () => {
    const databaseUrl = await resolveAppDataDatabaseUrl(id);
    const connect = async (disableSsl = false): Promise<PgClient> => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw rawSqlTimeoutError(timeoutMs);
      const candidate = new pg.Client({
        connectionString: rawSqlConnectionString(databaseUrl, { disableSsl }),
        connectionTimeoutMillis: remainingMs,
        statement_timeout: timeoutMs,
      });
      // node-postgres emits connection-level failures on Client even when no
      // query is active. Always consume that event and route it through the
      // same timeout/commit-outcome state machine instead of letting an
      // unhandled EventEmitter error terminate the process.
      candidate.on('error', (error) => {
        if (client === candidate) stop(error);
      });
      client = candidate;
      clientEndPromise = undefined;
      if (stopError) {
        void endClient();
        throw stopError;
      }
      try {
        await candidate.connect();
      } catch (error) {
        void endClient();
        throw error;
      }
      if (stopError) {
        void endClient();
        throw stopError;
      }
      return candidate;
    };

    let dataClient: PgClient;
    try {
      dataClient = await connect();
    } catch (error) {
      if (
        rawSqlTlsPreference(databaseUrl) !== 'prefer' ||
        !rawSqlServerHasNoTls(error) ||
        stopError
      ) {
        throw error;
      }
      // Match postgres.js/libpq sslmode=prefer: only retry without TLS when
      // the server explicitly reports that it has no SSL support.
      dataClient = await connect(true);
    }
    let transactionOpen = false;
    try {
      await dataClient.query('begin');
      transactionOpen = true;
      await acquireDataReadGuard(dataClient, id, {});
      await dataClient.query(`set local statement_timeout = ${timeoutMs}`);
      await dataClient.query('set local search_path = data, public');
      const presented = await executeBoundedRawSql(dataClient, statement);
      if (stopError) throw stopError;
      if (signal?.aborted) {
        stop(rawSqlAbortError(signal));
        throw stopError!;
      }
      if (Date.now() >= deadline) {
        stop(rawSqlTimeoutError(timeoutMs));
        throw stopError!;
      }
      commitPhase = 'commit_in_flight';
      try {
        await dataClient.query('commit');
      } catch (error) {
        throw stopError ?? rawSqlOutcomeUnknownError(error);
      }
      commitPhase = 'commit_confirmed';
      transactionOpen = false;
      return presented;
    } catch (error) {
      if (transactionOpen && commitPhase === 'before_commit' && !stopError) {
        await dataClient.query('rollback').catch(() => {});
        transactionOpen = false;
      }
      if ((error as { code?: unknown }).code === '57014') {
        throw rawSqlTimeoutError(timeoutMs);
      }
      throw boundedRawSqlError(error);
    }
  };

  try {
    const result = await Promise.race([execute(), stopped]);
    scheduleDataChangesPrune(id);
    return result;
  } catch (error) {
    throw boundedRawSqlError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Initiate cleanup without making the public timeout depend on a socket
    // close acknowledgement that may never arrive after a network failure.
    void endClient();
  }
}

async function insertRow(
  tx: TransactionSql,
  tableName: string,
  table: DataTable,
  value: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
  for (const key of Object.keys(value)) {
    const field = fieldFromTable(table, key);
    if (!field) {
      throw new AppError(`Cannot insert system field "${key}".`, 400);
    }
  }
  const completed: Record<string, JsonValue> = { ...value };
  for (const [name, field] of Object.entries(table.fields)) {
    if (!Object.hasOwn(completed, name)) {
      const defaulted = defaultValue(field);
      if (defaulted !== undefined) completed[name] = defaulted;
      else if (field.optional) continue;
      else throw new AppError(`Missing required field "${name}".`, 400);
    }
    validateFieldValue(field, completed[name]);
  }
  assertRowSize(completed);
  const id = ulid().toLowerCase();
  const columns = ['id', ...Object.keys(completed)];
  const params: SqlParam[] = [id];
  const expressions = ['$1'];
  for (const name of Object.keys(completed)) {
    const field = ownValue(table.fields, name)!;
    params.push(parameterValue(field, completed[name]));
    expressions.push(parameterExpression(field, params.length));
  }
  const [row] = await tx.unsafe<Record<string, unknown>[]>(
    `insert into ${tableSql(tableName)} (${columns.map(qi).join(', ')}) ` +
      `values (${expressions.join(', ')}) returning *`,
    params,
  );
  if (!row) throw new AppError('Data Table insert failed.', 500);
  return serializeStoredRow(row);
}

async function patchRow(
  tx: TransactionSql,
  tableName: string,
  table: DataTable,
  id: string,
  value: Record<string, JsonValue>,
  unset: string[],
): Promise<Record<string, JsonValue> | null> {
  if (Object.keys(value).length === 0 && unset.length === 0) {
    const [row] = await tx.unsafe<Record<string, unknown>[]>(
      `select * from ${tableSql(tableName)} where id = $1`,
      [id],
    );
    return row ? serializeStoredRow(row) : null;
  }
  assertRowSize(value);
  const params: SqlParam[] = [];
  const assignments: string[] = [];
  const assigned = new Set<string>();
  for (const [name, child] of Object.entries(value)) {
    const field = fieldFromTable(table, name);
    if (!field)
      throw new AppError(`Cannot update system field "${name}".`, 400);
    validateFieldValue(field, child);
    assigned.add(name);
    params.push(parameterValue(field, child));
    assignments.push(
      `${qi(name)} = ${parameterExpression(field, params.length)}`,
    );
  }
  for (const name of unset) {
    if (assigned.has(name)) {
      throw new AppError(
        `Data Table field "${name}" cannot be both updated and unset.`,
        400,
      );
    }
    const field = fieldFromTable(table, name);
    if (!field) throw new AppError(`Cannot unset system field "${name}".`, 400);
    if (!field.optional) {
      throw new AppError(`Cannot unset required field "${name}".`, 400);
    }
    assigned.add(name);
    assignments.push(`${qi(name)} = null`);
  }
  params.push(id);
  const [row] = await tx.unsafe<Record<string, unknown>[]>(
    `update ${tableSql(tableName)} set ${assignments.join(', ')}, ` +
      `${qi('updated_at')} = now() where ${qi('id')} = $${params.length} returning *`,
    params,
  );
  return row ? serializeStoredRow(row) : null;
}

async function incrementRow(
  tx: TransactionSql,
  tableName: string,
  table: DataTable,
  id: string,
  name: string,
  amount: number,
): Promise<Record<string, JsonValue> | null> {
  const field = fieldFromTable(table, name);
  if (!field) {
    throw new AppError(`Cannot increment system field "${name}".`, 400);
  }
  if (field.kind !== 'integer' && field.kind !== 'number') {
    throw new AppError(`Cannot increment non-numeric field "${name}".`, 400);
  }
  if (field.optional) {
    throw new AppError(`Cannot increment optional field "${name}".`, 400);
  }
  validateFieldValue(field, amount);
  const [row] = await tx.unsafe<Record<string, unknown>[]>(
    `update ${tableSql(tableName)} set ${qi(name)} = ${qi(name)} + $1, ` +
      `${qi('updated_at')} = now() where ${qi('id')} = $2 returning *`,
    [parameterValue(field, amount), id],
  );
  return row ? serializeStoredRow(row) : null;
}

export async function mutateDataTable(
  id: string,
  input: unknown,
  options: DataMutationOptions = {},
): Promise<{
  results: Array<Record<string, JsonValue> | null>;
  revision: number;
}> {
  const request = dataMutationRequestSchema.parse(input);
  const sql = await openDataClient(id);
  try {
    const result = await sql.begin(async (tx) => {
      await acquireDataReadGuard(tx, id, options);
      const schema = await schemaInTransaction(tx);
      const results: Array<Record<string, JsonValue> | null> = [];
      for (const operation of request.operations) {
        const table = tableFromSchema(schema, operation.table);
        let operationResult: Record<string, JsonValue> | null;
        if (operation.type === 'insert') {
          operationResult = await insertRow(
            tx,
            operation.table,
            table,
            operation.value,
          );
        } else if (operation.type === 'patch') {
          operationResult = await patchRow(
            tx,
            operation.table,
            table,
            operation.id,
            operation.value,
            operation.unset,
          );
        } else if (operation.type === 'increment') {
          operationResult = await incrementRow(
            tx,
            operation.table,
            table,
            operation.id,
            operation.field,
            operation.amount,
          );
        } else {
          const [row] = await tx.unsafe<Record<string, unknown>[]>(
            `delete from ${tableSql(operation.table)} where id = $1 returning *`,
            [operation.id],
          );
          operationResult = row ? serializeStoredRow(row) : null;
        }
        results.push(operationResult);
        if (
          options.resultMaxChars !== undefined &&
          JSON.stringify(results, null, 2).length > options.resultMaxChars
        ) {
          throw new AppError(
            'Data Table mutation result exceeds the Agent output budget. ' +
              'The entire batch was rolled back. Split it into smaller ' +
              'batches or use raw_sql with a narrow RETURNING clause.',
            413,
          );
        }
      }
      const [revisionRow] = await tx<{ revision: string }[]>`
        select coalesce(max(seq), 0)::text as revision from _hatch.changes
      `;
      return {
        results,
        revision: parseDataRevision(revisionRow?.revision ?? '0'),
      };
    });
    scheduleDataChangesPrune(id);
    return result;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function scheduleDataChangesPrune(id: string): void {
  // Retention is detached best-effort work. App deletion can race with
  // opening its Data database after the request has already committed.
  void pruneDataChanges(id).catch(() => {});
}

async function pruneDataChanges(id: string): Promise<void> {
  const g = globalThis as DataServiceGlobal;
  g.__hatchDataLastPrune ??= new Map();
  const now = Date.now();
  if (now - (g.__hatchDataLastPrune.get(id) ?? 0) < CHANGE_PRUNE_INTERVAL_MS) {
    return;
  }
  g.__hatchDataLastPrune.set(id, now);
  const sql = await openDataClient(id);
  try {
    await sql`
      delete from _hatch.changes
      where created_at < now() - interval '24 hours'
        and seq < (select greatest(coalesce(max(seq), 0) - 10000, 0) from _hatch.changes)
    `;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

export type DataTableInfo = {
  schema: DataSchemaDescriptor;
  schemaHash: string;
  tables: Array<{ name: string; rowCount: number }>;
  migrations: Array<{
    id: number;
    deploymentId: string;
    schemaHash: string;
    destructive: boolean;
    sql: string;
    appliedAt: string;
  }>;
};

export async function inspectDataTables(
  id: string,
): Promise<DataTableInfo | null> {
  const sql = await openDataClient(id);
  try {
    const metadata = await sql.begin(
      'isolation level repeatable read',
      async (tx) => {
        await acquireDataReadGuard(tx, id, {});
        const [current] = await tx<
          { schema_snapshot: unknown; schema_hash: string }[]
        >`
          select schema_snapshot, schema_hash
          from _hatch.migrations order by id desc limit 1
        `;
        if (!current) return null;
        const migrations = await tx<
          {
            id: number;
            deployment_id: string;
            schema_hash: string;
            destructive: boolean;
            migration_sql: string;
            applied_at: Date;
          }[]
        >`
          select id, deployment_id, schema_hash, destructive, migration_sql, applied_at
          from _hatch.migrations order by id desc
        `;
        return {
          current,
          schema: parseDataSchemaDescriptor(current.schema_snapshot),
          migrations,
        };
      },
    );
    if (!metadata) return null;

    const tableNames = Object.keys(metadata.schema.tables);
    const estimates =
      tableNames.length === 0
        ? []
        : await sql.unsafe<{ name: string; estimated_count: number }[]>(
            `select c.relname as name, ` +
              `greatest(c.reltuples, 0)::double precision as estimated_count ` +
              `from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
              `where n.nspname = 'data' and c.relkind = 'r' ` +
              `and c.relname = any($1::text[])`,
            [tableNames],
          );
    const counts = new Map(
      estimates.map((row) => [
        row.name,
        Math.max(0, Math.round(Number(row.estimated_count))),
      ]),
    );
    return {
      schema: metadata.schema,
      schemaHash: metadata.current.schema_hash,
      tables: tableNames.map((name) => ({
        name,
        rowCount: counts.get(name) ?? 0,
      })),
      migrations: metadata.migrations.map((row) => ({
        id: row.id,
        deploymentId: row.deployment_id,
        schemaHash: row.schema_hash,
        destructive: row.destructive,
        sql: row.migration_sql,
        appliedAt: row.applied_at.toISOString(),
      })),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
