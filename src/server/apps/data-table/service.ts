/** Query, mutation, inspection, and validation for managed Data Tables. */
import { createHash } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { ulid } from 'ulid';
import { z } from 'zod';
import { db } from '~/db';
import type { JsonValue } from '~/db/schema';
import { AppError } from '~server/errors';
import { DATA_MIGRATION_LOCK_KEY } from './migrate';
import { resolveAppDataDatabaseUrl } from './provision';
import { parseDataRevision } from './revision';
import type {
  DataField,
  DataIndex,
  DataSchemaDescriptor,
  DataTable,
} from './schema';
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
export const DATA_REQUEST_MAX_BYTES = 1_000_000;
const DATA_ROW_MAX_BYTES = 256 * 1024;
const CHANGE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CURSOR_NULL_ALIAS = '__hatch_cursor_order_is_null';

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
  index: z.string().min(1).optional(),
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

export type DataQueryResult = {
  items: Record<string, JsonValue>[];
  cursor: string | null;
  revision: number;
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
  if (field?.kind === 'json') return `$${index}::jsonb`;
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
    index: query.index ?? null,
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

async function acquireReadLock(tx: TransactionSql): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`
    select pg_try_advisory_xact_lock_shared(${DATA_MIGRATION_LOCK_KEY}) as ok
  `;
  if (!row?.ok) {
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
    where: (row, { eq }) => eq(row.id, id),
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
  tx: TransactionSql,
  id: string,
  options: DataTableAccessOptions,
): Promise<void> {
  // Lock before reading the platform fence. If a deploy commits its fence just
  // after this check, its exclusive migration lock still waits for this
  // transaction, so the request finishes against the schema observed here.
  await acquireReadLock(tx);
  await assertDataTableAccess(id, options);
}

type QueryCondition = DataQueryRequest['where'][number];

function physicalIndexFields(index: DataIndex): string[] {
  // Keep this in sync with createIndexStep: non-unique indexes receive the
  // deterministic row id as a physical tie-breaker without changing the
  // public descriptor or the semantics of unique indexes.
  if (index.unique || index.fields.includes('id')) return index.fields;
  return [...index.fields, 'id'];
}

function conditionsGuaranteeNonNull(
  conditions: readonly QueryCondition[],
): boolean {
  return conditions.some((condition) => {
    if (condition.op === 'eq') return condition.value !== null;
    if (condition.op === 'in') {
      return (
        Array.isArray(condition.value) &&
        condition.value.length > 0 &&
        condition.value.every((value) => value !== null)
      );
    }
    return true;
  });
}

function uniqueKeyIsNonNull(
  table: DataTable,
  index: DataIndex,
  conditionsByField: ReadonlyMap<string, readonly QueryCondition[]>,
): boolean {
  return index.fields.every((name) => {
    const field = queryFieldFromTable(table, name);
    return (
      !field.optional ||
      conditionsGuaranteeNonNull(conditionsByField.get(name) ?? [])
    );
  });
}

function invalidIndexShape(index: DataIndex): never {
  throw new AppError(
    `Index "${index.name}" cannot support this query. Use equality filters ` +
      'for its leading fields, at most one range field next, and order by ' +
      'the next indexed field.',
    400,
  );
}

function isSingleKeyEquality(
  table: DataTable,
  fieldName: string,
  condition: QueryCondition,
): boolean {
  if (condition.op !== 'eq') return false;
  const field = queryFieldFromTable(table, fieldName);
  return field.kind !== 'json' || condition.value !== null || !field.optional;
}

function validateIndexedQuery(table: DataTable, query: DataQueryRequest): void {
  for (const condition of query.where) {
    queryFieldFromTable(table, condition.field);
  }
  const orderField = query.orderBy?.field ?? 'id';
  queryFieldFromTable(table, orderField);

  const index = query.index
    ? table.indexes.find((candidate) => candidate.name === query.index)
    : undefined;
  if (query.index && !index) {
    throw new AppError(`Unknown Data Table index "${query.index}".`, 400);
  }

  const nonIdFields = new Set(
    query.where
      .map((condition) => condition.field)
      .filter((field) => field !== 'id'),
  );
  if (orderField !== 'id') nonIdFields.add(orderField);
  if (nonIdFields.size === 0) return;
  if (!index) {
    throw new AppError(
      'Filtered or ordered Data Table queries must name a declared index.',
      400,
    );
  }

  const conditionsByField = new Map<string, QueryCondition[]>();
  for (const condition of query.where) {
    const conditions = conditionsByField.get(condition.field) ?? [];
    conditions.push(condition);
    conditionsByField.set(condition.field, conditions);
  }

  const remainingConditionFields = new Set(conditionsByField.keys());
  const fields = physicalIndexFields(index);
  let position = 0;
  const equalityFields = new Set<string>();
  while (position < fields.length) {
    const field = fields[position]!;
    const conditions = conditionsByField.get(field) ?? [];
    if (
      conditions.length === 0 ||
      conditions.some(
        (condition) => !isSingleKeyEquality(table, field, condition),
      )
    ) {
      break;
    }
    equalityFields.add(field);
    remainingConditionFields.delete(field);
    position += 1;
  }

  // Non-unique indexes receive id as their final physical key. Equality over
  // that complete key identifies at most one row, so no further ordering key is
  // needed even though the public index descriptor itself is not unique.
  if (position >= fields.length && equalityFields.has('id')) return;

  const rangeField = fields[position];
  const rangeConditions = rangeField
    ? (conditionsByField.get(rangeField) ?? [])
    : [];
  if (rangeConditions.length > 0) {
    const operators = rangeConditions.map((condition) => condition.op);
    const isRange = operators.every((operator) =>
      ['gt', 'gte', 'lt', 'lte'].includes(operator),
    );
    const isSingleIn = operators.length === 1 && operators[0] === 'in';
    const isJsonNullEquality =
      rangeConditions.length === 1 &&
      rangeConditions[0]?.op === 'eq' &&
      rangeConditions[0].value === null &&
      queryFieldFromTable(table, rangeField!).kind === 'json';
    if (!isRange && !isSingleIn && !isJsonNullEquality) {
      invalidIndexShape(index);
    }
    remainingConditionFields.delete(rangeField!);
  }
  if (remainingConditionFields.size > 0) invalidIndexShape(index);

  const uniqueCanTerminate =
    index.unique && uniqueKeyIsNonNull(table, index, conditionsByField);
  if (uniqueCanTerminate && position >= index.fields.length) return;

  const effectiveOrderFields = equalityFields.has(orderField)
    ? ['id']
    : orderField === 'id'
      ? ['id']
      : [orderField, 'id'];
  if (rangeConditions.length > 0 && effectiveOrderFields[0] !== rangeField) {
    invalidIndexShape(index);
  }

  for (const field of effectiveOrderFields) {
    if (fields[position] !== field) invalidIndexShape(index);
    position += 1;
    if (uniqueCanTerminate && position >= index.fields.length) return;
  }
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
  validateIndexedQuery(table, query);
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

  const orderField = query.orderBy?.field ?? 'id';
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
  options: DataTableAccessOptions = {},
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
      const more = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const items = page.map((row) => {
        const { [CURSOR_NULL_ALIAS]: _cursorNull, ...stored } = row;
        return serializeStoredRow(stored);
      });
      const [revisionRow] = await tx<{ revision: string }[]>`
        select coalesce(max(seq), 0)::text as revision from _hatch.changes
      `;
      return {
        items,
        cursor: more
          ? encodeCursor(
              page.at(-1)!,
              queryFingerprint,
              orderField,
              orderDirection,
            )
          : null,
        revision: parseDataRevision(revisionRow?.revision ?? '0'),
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
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
  options: DataTableAccessOptions = {},
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
        if (operation.type === 'insert') {
          results.push(
            await insertRow(tx, operation.table, table, operation.value),
          );
        } else if (operation.type === 'patch') {
          results.push(
            await patchRow(
              tx,
              operation.table,
              table,
              operation.id,
              operation.value,
              operation.unset,
            ),
          );
        } else if (operation.type === 'increment') {
          results.push(
            await incrementRow(
              tx,
              operation.table,
              table,
              operation.id,
              operation.field,
              operation.amount,
            ),
          );
        } else {
          const [row] = await tx.unsafe<Record<string, unknown>[]>(
            `delete from ${tableSql(operation.table)} where id = $1 returning *`,
            [operation.id],
          );
          results.push(row ? serializeStoredRow(row) : null);
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
    // Retention is detached best-effort work. App deletion can race with
    // opening its Data database after the mutation has already committed.
    void pruneDataChanges(id).catch(() => {});
    return result;
  } finally {
    await sql.end({ timeout: 5 });
  }
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
