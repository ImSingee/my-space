/** Trusted descriptor types and validation for app-managed Data Tables. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '~/db/schema';

export const DATA_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    DATA_NAME_RE,
    'must start with a letter and contain letters, digits, or underscores',
  )
  .refine((name) => !Object.hasOwn(Object.prototype, name), {
    message: 'must not collide with an Object prototype property',
  });

const POSTGRES_SYSTEM_COLUMNS = new Set([
  'tableoid',
  'xmin',
  'cmin',
  'xmax',
  'cmax',
  'ctid',
]);

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

const defaultSchema = z.union([
  jsonValueSchema,
  z.object({ $hatch: z.literal('now') }).strict(),
]);

/** Runtime-compatible timestamp validation shared by schema defaults and rows. */
export function isValidDataDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function normalizeDataDateTime(value: string): string {
  return new Date(value).toISOString();
}

export function isDataDefaultNow(value: unknown): value is { $hatch: 'now' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { $hatch?: unknown }).$hatch === 'now'
  );
}

export const dataFieldSchema = z
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
    default: defaultSchema.optional(),
    enumValues: z.array(z.string()).min(1).optional(),
    referenceTable: nameSchema.optional(),
    renamedFrom: nameSchema.optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.kind === 'enum' && !field.enumValues) {
      ctx.addIssue({
        code: 'custom',
        message: 'enum fields require enumValues',
      });
    }
    if (
      field.enumValues &&
      new Set(field.enumValues).size !== field.enumValues.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'enumValues must be unique' });
    }
    if (field.kind !== 'enum' && field.enumValues) {
      ctx.addIssue({
        code: 'custom',
        message: 'enumValues is only valid for enum fields',
      });
    }
    if (field.kind === 'reference' && !field.referenceTable) {
      ctx.addIssue({
        code: 'custom',
        message: 'reference fields require referenceTable',
      });
    }
    if (field.kind !== 'reference' && field.referenceTable) {
      ctx.addIssue({
        code: 'custom',
        message: 'referenceTable is only valid for reference fields',
      });
    }
    if (field.default !== undefined && field.kind === 'reference') {
      ctx.addIssue({
        code: 'custom',
        message: 'reference fields cannot declare defaults',
      });
    }
    const usesDefaultNow =
      field.kind === 'datetime' && isDataDefaultNow(field.default);
    if (
      isDataDefaultNow(field.default) &&
      field.kind !== 'datetime' &&
      field.kind !== 'json'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'defaultNow is only valid for datetime fields',
      });
    }
    if (field.default !== undefined && !usesDefaultNow) {
      const value = field.default;
      const valid = (() => {
        switch (field.kind) {
          case 'string':
            return typeof value === 'string';
          case 'datetime':
            return isValidDataDateTime(value);
          case 'enum':
            return (
              typeof value === 'string' && field.enumValues?.includes(value)
            );
          case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
          case 'number':
            return typeof value === 'number' && Number.isFinite(value);
          case 'boolean':
            return typeof value === 'boolean';
          case 'json':
            return true;
          case 'reference':
            return false;
        }
      })();
      if (!valid) {
        ctx.addIssue({
          code: 'custom',
          message: `default does not match ${field.kind} field`,
        });
      }
    }
  });

export const dataIndexSchema = z
  .object({
    name: nameSchema,
    fields: z.array(nameSchema).min(1).max(8),
    unique: z.boolean(),
  })
  .strict();

export const dataTableSchema = z
  .object({
    fields: z.record(nameSchema, dataFieldSchema),
    indexes: z.array(dataIndexSchema),
    renamedFrom: nameSchema.optional(),
  })
  .strict()
  .superRefine((table, ctx) => {
    for (const reserved of [
      'id',
      'createdAt',
      'updatedAt',
      'created_at',
      'updated_at',
    ]) {
      if (Object.hasOwn(table.fields, reserved)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', reserved],
          message: `${reserved} is a platform-managed field`,
        });
      }
    }
    for (const [fieldName, field] of Object.entries(table.fields)) {
      if (POSTGRES_SYSTEM_COLUMNS.has(fieldName)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldName],
          message: `${fieldName} is a PostgreSQL system column`,
        });
      }
      if (field.renamedFrom && POSTGRES_SYSTEM_COLUMNS.has(field.renamedFrom)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', fieldName, 'renamedFrom'],
          message: `${field.renamedFrom} is a PostgreSQL system column`,
        });
      }
    }
    const names = new Set<string>();
    for (const [index, value] of table.indexes.entries()) {
      if (names.has(value.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['indexes', index, 'name'],
          message: `duplicate index ${value.name}`,
        });
      }
      names.add(value.name);
      if (new Set(value.fields).size !== value.fields.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['indexes', index, 'fields'],
          message: `index ${value.name} fields must be unique`,
        });
      }
      for (const field of value.fields) {
        if (
          !Object.hasOwn(table.fields, field) &&
          !['id', 'createdAt', 'updatedAt'].includes(field)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['indexes', index, 'fields'],
            message: `unknown index field ${field}`,
          });
        }
      }
    }
  });

export const dataSchemaDescriptorSchema = z
  .object({
    version: z.literal(1),
    tables: z.record(nameSchema, dataTableSchema),
  })
  .strict()
  .superRefine((schema, ctx) => {
    const priorTables = new Set<string>();
    for (const [tableName, table] of Object.entries(schema.tables)) {
      if (table.renamedFrom) {
        if (priorTables.has(table.renamedFrom)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tables', tableName, 'renamedFrom'],
            message: `multiple tables rename from ${table.renamedFrom}`,
          });
        }
        priorTables.add(table.renamedFrom);
      }
      const priorFields = new Set<string>();
      for (const [fieldName, field] of Object.entries(table.fields)) {
        if (field.renamedFrom) {
          if (priorFields.has(field.renamedFrom)) {
            ctx.addIssue({
              code: 'custom',
              path: ['tables', tableName, 'fields', fieldName, 'renamedFrom'],
              message: `multiple fields rename from ${field.renamedFrom}`,
            });
          }
          priorFields.add(field.renamedFrom);
        }
        if (
          field.referenceTable &&
          !Object.hasOwn(schema.tables, field.referenceTable)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['tables', tableName, 'fields', fieldName, 'referenceTable'],
            message: `unknown referenced table ${field.referenceTable}`,
          });
        }
      }
    }
  });

export type DataField = z.infer<typeof dataFieldSchema>;
export type DataIndex = z.infer<typeof dataIndexSchema>;
export type DataTable = z.infer<typeof dataTableSchema>;
export type DataSchemaDescriptor = z.infer<typeof dataSchemaDescriptorSchema>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function parseDataSchemaDescriptor(
  value: unknown,
): DataSchemaDescriptor {
  return dataSchemaDescriptorSchema.parse(value);
}

export function dataSchemaHash(schema: DataSchemaDescriptor): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(schema)))
    .digest('hex');
}
