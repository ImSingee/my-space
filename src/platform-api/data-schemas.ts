/** Shared strict data contracts for public API, internal API and Tools. */
import { z } from 'zod';

/** Same streamed-byte ceiling as the internal data-call transport. */
export const DATA_CALL_BODY_LIMIT = 256 * 1024 * 1024;

// Keep the existing internal REST unknown-field behavior. The public API
// explicitly closes this same object schema at its transport boundary.
export const queryAppDbRequestSchema = z.object({
  sql: z.string().min(1),
});

/** Empty means the first page; a continuation is a server-returned key. */
export const queryAppKvCursorSchema = z.string().max(512);

const queryAppKvListRequestSchema = z
  .object({
    action: z.literal('list'),
    cursor: queryAppKvCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(100),
    revealSecrets: z.boolean().default(false),
  })
  .strict()
  .transform(({ cursor, ...input }) => ({
    ...input,
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
  }));

const queryAppKvGetRequestSchema = z
  .object({
    action: z.literal('get'),
    key: z.string(),
    revealSecrets: z.boolean().default(false),
  })
  .strict();

const queryAppKvSetRequestSchema = z
  .object({
    action: z.literal('set'),
    key: z.string(),
    value: z.string(),
    secret: z.boolean().optional(),
  })
  .strict();

const queryAppKvDeleteRequestSchema = z
  .object({
    action: z.literal('delete'),
    key: z.string(),
  })
  .strict();

export const queryAppKvRequestSchema = z.discriminatedUnion('action', [
  queryAppKvListRequestSchema,
  queryAppKvGetRequestSchema,
  queryAppKvSetRequestSchema,
  queryAppKvDeleteRequestSchema,
]);
/** Request accepted from the runner; list limit is optional before parsing. */
export type QueryAppKvRequest = z.input<typeof queryAppKvRequestSchema>;
/** Strictly parsed request used by the platform implementation. */
export type ParsedQueryAppKvRequest = z.output<typeof queryAppKvRequestSchema>;

export type QueryAppKvRecord = {
  key: string;
  value: string | null;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QueryAppKvResponse =
  | {
      action: 'list';
      items: QueryAppKvRecord[];
      nextCursor: string | null;
    }
  | { action: 'get'; record: QueryAppKvRecord | null }
  | { action: 'set'; record: QueryAppKvRecord }
  | { action: 'delete'; ok: boolean };

export type QueryAppDataTableJsonValue =
  | string
  | number
  | boolean
  | null
  | QueryAppDataTableJsonValue[]
  | { [key: string]: QueryAppDataTableJsonValue };

export const QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH = 60_000;
export const queryAppDataTableCursorSchema = z
  .string()
  .max(QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH);

const queryAppDataTableJsonValueSchema: z.ZodType<QueryAppDataTableJsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(queryAppDataTableJsonValueSchema),
      z.record(z.string(), queryAppDataTableJsonValueSchema),
    ]),
  );

const queryAppDataTableWhereSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']),
    value: queryAppDataTableJsonValueSchema,
  })
  .strict();

const queryAppDataTableInspectRequestSchema = z
  .object({
    action: z.literal('inspect'),
    table: z.string().optional(),
  })
  .strict()
  .transform(({ table, ...input }) => ({
    ...input,
    ...(table === undefined || table === '' ? {} : { table }),
  }));

const queryAppDataTableQueryRequestSchema = z
  .object({
    action: z.literal('query'),
    table: z.string().min(1),
    where: z.array(queryAppDataTableWhereSchema).max(16).default([]),
    orderBy: z
      .object({
        field: z.string().min(1),
        direction: z.enum(['asc', 'desc']).default('asc'),
      })
      .strict()
      .optional(),
    cursor: queryAppDataTableCursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()
  .transform(({ cursor, ...input }) => ({
    ...input,
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
  }));

const queryAppDataTableMutationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('insert'),
      table: z.string().min(1),
      value: z.record(z.string(), queryAppDataTableJsonValueSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('patch'),
      table: z.string().min(1),
      id: z.string().min(1),
      value: z.record(z.string(), queryAppDataTableJsonValueSchema),
      unset: z.array(z.string().min(1)).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal('increment'),
      table: z.string().min(1),
      id: z.string().min(1),
      field: z.string().min(1),
      amount: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal('delete'),
      table: z.string().min(1),
      id: z.string().min(1),
    })
    .strict(),
]);

const queryAppDataTableMutateRequestSchema = z
  .object({
    action: z.literal('mutate'),
    operations: z.array(queryAppDataTableMutationSchema).min(1).max(100),
  })
  .strict();

const queryAppDataTableRawSqlRequestSchema = z
  .object({
    action: z.literal('raw_sql'),
    sql: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, 'SQL must not be blank.'),
    timeoutMs: z.number().int().min(1_000).max(1_800_000).default(30_000),
  })
  .strict();

export const queryAppDataTableRequestSchema = z.discriminatedUnion('action', [
  queryAppDataTableInspectRequestSchema,
  queryAppDataTableQueryRequestSchema,
  queryAppDataTableMutateRequestSchema,
  queryAppDataTableRawSqlRequestSchema,
]);
/** Request accepted from the runner; fields with defaults remain optional. */
export type QueryAppDataTableRequest = z.input<
  typeof queryAppDataTableRequestSchema
>;
/** Strictly parsed request used by the platform implementation. */
export type ParsedQueryAppDataTableRequest = z.output<
  typeof queryAppDataTableRequestSchema
>;

export type QueryAppDataTableSchema = {
  version: 1;
  tables: Record<
    string,
    {
      fields: Record<
        string,
        {
          kind:
            | 'string'
            | 'integer'
            | 'number'
            | 'boolean'
            | 'datetime'
            | 'json'
            | 'enum'
            | 'reference';
          optional: boolean;
          default?: QueryAppDataTableJsonValue;
          enumValues?: string[];
          referenceTable?: string;
          renamedFrom?: string;
        }
      >;
      indexes: Array<{
        name: string;
        fields: string[];
        unique: boolean;
      }>;
      renamedFrom?: string;
    }
  >;
};

export type QueryAppDataTableResponse =
  | {
      action: 'inspect';
      data: {
        schema: QueryAppDataTableSchema;
        schemaHash: string;
        tables: Array<{ name: string; rowCount: number }>;
        truncated?: boolean;
      } | null;
    }
  | {
      action: 'query';
      items: Array<Record<string, QueryAppDataTableJsonValue>>;
      cursor: string | null;
      revision: number;
      truncated: boolean;
    }
  | {
      action: 'mutate';
      results: Array<Record<string, QueryAppDataTableJsonValue> | null>;
      revision: number;
    }
  | {
      action: 'raw_sql';
      results: Array<{
        command: string;
        count: number | null;
        rows: Array<Record<string, unknown>>;
      }>;
      truncated: boolean;
    };

const kvRecord = z
  .object({
    key: z.string(),
    value: z.string().nullable(),
    secret: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const queryAppKvResponseSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      items: z.array(kvRecord),
      nextCursor: z.string().nullable(),
    })
    .strict(),
  z.object({ action: z.literal('get'), record: kvRecord.nullable() }).strict(),
  z.object({ action: z.literal('set'), record: kvRecord }).strict(),
  z.object({ action: z.literal('delete'), ok: z.boolean() }).strict(),
]);
const field = z
  .object({
    kind: z.enum([
      'string',
      'integer',
      'number',
      'boolean',
      'datetime',
      'json',
      'enum',
      'reference',
    ]),
    optional: z.boolean(),
    default: z.json().optional(),
    enumValues: z.array(z.string()).optional(),
    referenceTable: z.string().optional(),
    renamedFrom: z.string().optional(),
  })
  .strict();
const dataSchema = z
  .object({
    version: z.literal(1),
    tables: z.record(
      z.string(),
      z
        .object({
          fields: z.record(z.string(), field),
          indexes: z.array(
            z
              .object({
                name: z.string(),
                fields: z.array(z.string()),
                unique: z.boolean(),
              })
              .strict(),
          ),
          renamedFrom: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const record = z.record(z.string(), queryAppDataTableJsonValueSchema);
export const queryAppDataTableResponseSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('inspect'),
      data: z
        .object({
          schema: dataSchema,
          schemaHash: z.string(),
          tables: z.array(
            z.object({ name: z.string(), rowCount: z.number() }).strict(),
          ),
          truncated: z.boolean().optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('query'),
      items: z.array(record),
      cursor: z.string().nullable(),
      revision: z.number(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('mutate'),
      results: z.array(record.nullable()),
      revision: z.number(),
    })
    .strict(),
  z
    .object({
      action: z.literal('raw_sql'),
      results: z.array(
        z
          .object({
            command: z.string(),
            count: z.number().nullable(),
            rows: z.array(z.record(z.string(), z.unknown())),
          })
          .strict(),
      ),
      truncated: z.boolean(),
    })
    .strict(),
]);
export const queryAppDbResponseSchema = z
  .object({ text: z.string(), rowCount: z.number() })
  .strict();
