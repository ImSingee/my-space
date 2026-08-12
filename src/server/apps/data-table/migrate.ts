/** Generate and apply forward-only migrations for managed Data Tables. */
import { createHash } from 'node:crypto';
import postgres, { type TransactionSql } from 'postgres';
import { AppError } from '~server/errors';
import {
  appDataDatabaseExists,
  ensureAppDataDatabase,
  resolveAppDataDatabaseUrl,
} from './provision';
import {
  dataSchemaHash,
  isDataDefaultNow,
  normalizeDataDateTime,
  parseDataSchemaDescriptor,
  type DataField,
  type DataIndex,
  type DataSchemaDescriptor,
  type DataTable,
} from './schema';

const MIGRATION_LOCK_KEY = 0x4844544d;

export type DataMigrationStep = {
  description: string;
  sql: string;
  destructive: boolean;
};

export type DataMigrationPlan = {
  fromHash: string | null;
  toHash: string;
  steps: DataMigrationStep[];
  destructive: boolean;
  approvalToken: string;
};

export type AppliedDataMigration = {
  hash: string;
  schema: DataSchemaDescriptor;
  plan: DataMigrationPlan;
  applied: boolean;
};

export class DataMigrationApprovalRequired extends AppError {
  constructor(readonly plan: DataMigrationPlan) {
    super(
      'Data Table migration contains destructive changes and requires ' +
        'allow_destructive_data_migration=true with the matching preview ' +
        'token.\n' +
        plan.steps
          .filter((step) => step.destructive)
          .map((step) => `- ${step.description}`)
          .join('\n') +
        `\nApproval token: ${plan.approvalToken}` +
        '\nRetry with data_migration_approval_token set to this exact value.' +
        '\n\nGenerated migration SQL:\n' +
        plan.steps.map((step) => `${step.sql};`).join('\n'),
      409,
    );
    this.name = 'DataMigrationApprovalRequired';
  }
}

/**
 * The migration transaction reached COMMIT, but a second connection could not
 * determine whether PostgreSQL committed it. Callers must keep the activation
 * fence in place until a retry or explicit rollback resolves the outcome.
 */
export class DataMigrationOutcomeUnknown extends Error {
  constructor(readonly originalError: unknown) {
    super(
      'The Data Table migration outcome could not be confirmed. Data access ' +
        'remains fenced; retry the deployment or explicitly restore a deployment.',
    );
    this.name = 'DataMigrationOutcomeUnknown';
  }
}

function qi(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableName(value: string): string {
  return `${qi('data')}.${qi(value)}`;
}

function ownValue<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function physicalField(value: string): string {
  if (value === 'createdAt') return 'created_at';
  if (value === 'updatedAt') return 'updated_at';
  return value;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function objectName(...parts: string[]): string {
  const joined = parts.join('_');
  if (joined.length <= 63) return joined;
  const hash = createHash('sha256').update(joined).digest('hex').slice(0, 10);
  return `${joined.slice(0, 52)}_${hash}`;
}

function sqlType(field: DataField): string {
  switch (field.kind) {
    case 'string':
    case 'enum':
    case 'reference':
      return 'text';
    case 'integer':
      return 'integer';
    case 'number':
      return 'double precision';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'timestamptz';
    case 'json':
      return 'jsonb';
  }
}

function sqlDefault(field: DataField): string | null {
  if (field.default === undefined) return null;
  if (field.kind === 'datetime' && isDataDefaultNow(field.default)) {
    return 'now()';
  }
  switch (field.kind) {
    case 'string':
    case 'enum':
      return sqlString(String(field.default));
    case 'datetime':
      return sqlString(normalizeDataDateTime(String(field.default)));
    case 'integer':
    case 'number':
      return String(field.default);
    case 'boolean':
      return field.default ? 'true' : 'false';
    case 'json':
      return `${sqlString(JSON.stringify(field.default))}::jsonb`;
    case 'reference':
      return null;
  }
}

function fieldDefinition(name: string, field: DataField): string {
  const parts = [qi(name), sqlType(field)];
  if (!field.optional) parts.push('not null');
  const value = sqlDefault(field);
  if (value) parts.push(`default ${value}`);
  return parts.join(' ');
}

function enumConstraint(
  table: string,
  fieldName: string,
  field: DataField,
): string | null {
  if (field.kind !== 'enum' || !field.enumValues) return null;
  const constraint = objectName(table, fieldName, 'enum');
  return (
    `constraint ${qi(constraint)} check (` +
    `${qi(fieldName)} in (${field.enumValues.map(sqlString).join(', ')}))`
  );
}

function referenceConstraint(
  table: string,
  fieldName: string,
  field: DataField,
): DataMigrationStep | null {
  if (field.kind !== 'reference' || !field.referenceTable) return null;
  const name = objectName(table, fieldName, 'ref');
  return {
    description: `Add reference ${table}.${fieldName} -> ${field.referenceTable}`,
    destructive: false,
    sql:
      `alter table ${tableName(table)} add constraint ${qi(name)} ` +
      `foreign key (${qi(fieldName)}) references ${tableName(
        field.referenceTable,
      )} (${qi('id')})`,
  };
}

function indexPhysicalName(table: string, index: DataIndex): string {
  const readable = `${table}_${index.name}`;
  const hash = createHash('sha256')
    .update(JSON.stringify([table, index.name]))
    .digest('hex')
    .slice(0, 10);
  return `${readable.slice(0, 52)}_${hash}`;
}

function createIndexStep(table: string, index: DataIndex): DataMigrationStep {
  // Keyset queries always order equal values by id. Add that tie-breaker only
  // to non-unique indexes; adding it to a unique index would weaken the
  // uniqueness contract declared by the app.
  const physicalFields =
    index.unique || index.fields.includes('id')
      ? index.fields
      : [...index.fields, 'id'];
  const fields = physicalFields
    .map((field) => qi(physicalField(field)))
    .join(', ');
  return {
    description: `Create ${index.unique ? 'unique ' : ''}index ${table}.${index.name}`,
    destructive: false,
    sql: `create ${index.unique ? 'unique ' : ''}index ${qi(
      indexPhysicalName(table, index),
    )} on ${tableName(table)} (${fields})`,
  };
}

function createTableSteps(name: string, table: DataTable): DataMigrationStep[] {
  const definitions = [
    `${qi('id')} text primary key`,
    `${qi('created_at')} timestamptz not null default now()`,
    `${qi('updated_at')} timestamptz not null default now()`,
    ...Object.entries(table.fields).map(([fieldName, field]) =>
      fieldDefinition(fieldName, field),
    ),
    ...Object.entries(table.fields)
      .map(([fieldName, field]) => enumConstraint(name, fieldName, field))
      .filter((value): value is string => Boolean(value)),
  ];
  return [
    {
      description: `Create table ${name}`,
      destructive: false,
      sql: `create table ${tableName(name)} (${definitions.join(', ')})`,
    },
    ...table.indexes.map((index) => createIndexStep(name, index)),
    triggerStep(name),
  ];
}

function triggerStep(table: string): DataMigrationStep {
  return {
    description: `Enable realtime for ${table}`,
    destructive: false,
    sql:
      `create trigger ${qi(objectName(table, 'hatch_change'))} after insert or update or delete ` +
      `on ${tableName(table)} for each row execute function ${qi('_hatch')}.${qi(
        'capture_change',
      )}()`,
  };
}

function fieldsEqual(a: DataField, b: DataField): boolean {
  return (
    JSON.stringify({ ...a, renamedFrom: undefined }) ===
    JSON.stringify({
      ...b,
      renamedFrom: undefined,
    })
  );
}

function indexKey(index: DataIndex): string {
  return JSON.stringify({
    name: index.name,
    fields: index.fields,
    unique: index.unique,
  });
}

function enumValuesEqual(before: DataField, after: DataField): boolean {
  return (
    before.kind === 'enum' &&
    after.kind === 'enum' &&
    JSON.stringify(before.enumValues) === JSON.stringify(after.enumValues)
  );
}

function enumValuesNarrowed(before: DataField, after: DataField): boolean {
  if (before.kind !== 'enum' || after.kind !== 'enum') return false;
  const nextValues = new Set(after.enumValues ?? []);
  return (before.enumValues ?? []).some((value) => !nextValues.has(value));
}

function alterFieldSteps(
  table: string,
  name: string,
  before: DataField,
  after: DataField,
): DataMigrationStep[] {
  if (fieldsEqual(before, after)) return [];
  const steps: DataMigrationStep[] = [];
  const column = `${tableName(table)} alter column ${qi(name)}`;
  const replacesReference =
    before.kind === 'reference' || after.kind === 'reference';
  const enumValuesChanged =
    before.kind === 'enum' &&
    after.kind === 'enum' &&
    !enumValuesEqual(before, after);
  const kindChanged = before.kind !== after.kind;
  const oldDefault = sqlDefault(before);
  const nextDefault = sqlDefault(after);
  if (before.kind === 'enum' && (after.kind !== 'enum' || enumValuesChanged)) {
    const constraint = objectName(table, name, 'enum');
    steps.push({
      description:
        after.kind === 'enum'
          ? `Replace enum values for ${table}.${name}`
          : `Remove enum constraint from ${table}.${name}`,
      destructive: enumValuesNarrowed(before, after),
      sql: `alter table ${tableName(table)} drop constraint if exists ${qi(constraint)}`,
    });
  }
  // PostgreSQL rejects a column type change while a foreign-key constraint
  // still depends on that column. Drop the old constraint before any ALTER
  // TYPE, then recreate the target reference after all field changes.
  if (replacesReference) {
    const constraint = objectName(table, name, 'ref');
    steps.push({
      description: `Replace reference for ${table}.${name}`,
      destructive: false,
      sql: `alter table ${tableName(table)} drop constraint if exists ${qi(constraint)}`,
    });
  }
  // PostgreSQL validates the existing default expression while changing a
  // column type. Even when every stored value is convertible, an old default
  // such as a text literal can make ALTER TYPE fail before the replacement
  // default below is reached. Remove it first, then restore the target default
  // after the type change.
  const defaultRemovedForTypeChange = kindChanged && oldDefault !== null;
  if (defaultRemovedForTypeChange) {
    steps.push({
      description: `Remove default for ${table}.${name} before changing type`,
      destructive: false,
      sql: `alter table ${column} drop default`,
    });
  }
  if (kindChanged) {
    const widening = before.kind === 'integer' && after.kind === 'number';
    steps.push({
      description: `Change ${table}.${name} from ${before.kind} to ${after.kind}`,
      destructive: !widening,
      sql: `alter table ${column} type ${sqlType(after)} using ${qi(name)}::${sqlType(after)}`,
    });
  }
  const defaultChanged = oldDefault !== nextDefault;
  if (nextDefault !== null && (defaultChanged || defaultRemovedForTypeChange)) {
    steps.push({
      description: `Set default for ${table}.${name}`,
      destructive: false,
      sql: `alter table ${column} set default ${nextDefault}`,
    });
  } else if (
    nextDefault === null &&
    defaultChanged &&
    !defaultRemovedForTypeChange
  ) {
    steps.push({
      description: `Remove default for ${table}.${name}`,
      destructive: false,
      sql: `alter table ${column} drop default`,
    });
  }
  if (before.optional !== after.optional) {
    if (after.optional) {
      steps.push({
        description: `Allow nulls in ${table}.${name}`,
        destructive: false,
        sql: `alter table ${column} drop not null`,
      });
    } else {
      const message =
        `Cannot make field ${table}.${name} required while existing rows ` +
        'contain null. Backfill every row, then deploy this schema again.';
      steps.push({
        description: `Verify ${table}.${name} has no null values`,
        destructive: false,
        sql:
          `do $$ begin if exists (` +
          `select 1 from ${tableName(table)} where ${qi(name)} is null limit 1` +
          `) then raise exception ${sqlString(message)}; end if; end $$`,
      });
      steps.push({
        description: `Require ${table}.${name}`,
        destructive: false,
        sql: `alter table ${column} set not null`,
      });
    }
  }
  if (after.kind === 'enum' && (before.kind !== 'enum' || enumValuesChanged)) {
    const next = enumConstraint(table, name, after);
    if (next) {
      steps.push({
        description: `Validate enum values for ${table}.${name}`,
        destructive: false,
        sql: `alter table ${tableName(table)} add ${next}`,
      });
    }
  }
  if (replacesReference) {
    const next = referenceConstraint(table, name, after);
    if (next) steps.push(next);
  }
  return steps;
}

export function planDataMigration(
  before: DataSchemaDescriptor | null,
  after: DataSchemaDescriptor,
): DataMigrationPlan {
  const steps: DataMigrationStep[] = [];
  const beforeTables = before?.tables ?? {};
  const claimedOldTables = new Map<string, string>();
  const createdTables: Array<[string, DataTable]> = [];
  const deferredReferences: DataMigrationStep[] = [];

  const tableRenameClaims = new Map<string, string>();
  for (const [targetName, table] of Object.entries(after.tables)) {
    const sourceName = table.renamedFrom;
    if (!sourceName || sourceName === targetName) continue;
    if (Object.hasOwn(after.tables, sourceName)) {
      throw new Error(
        `Cannot rename table ${sourceName} to ${targetName} because the source ` +
          'table is still present in the target schema. Remove the source table ' +
          'entry when declaring the rename.',
      );
    }
    const claimedBy = tableRenameClaims.get(sourceName);
    if (claimedBy) {
      throw new Error(
        `Cannot rename table ${sourceName} to ${targetName} because the source ` +
          `table is already claimed by ${claimedBy}.`,
      );
    }
    tableRenameClaims.set(sourceName, targetName);
  }

  for (const [newName, nextTable] of Object.entries(after.tables)) {
    const declaredOldName = nextTable.renamedFrom;
    if (
      declaredOldName &&
      declaredOldName !== newName &&
      ownValue(beforeTables, newName) &&
      ownValue(beforeTables, declaredOldName)
    ) {
      throw new Error(
        `Cannot rename table ${declaredOldName} to ${newName} because both ` +
          'tables already exist in the deployed schema.',
      );
    }
    // `renamedFrom` stays in the declarative schema after the rename has been
    // applied. Prefer the current name when it already exists so subsequent
    // deploys are idempotent instead of trying to rename/create it again.
    const oldName = ownValue(beforeTables, newName)
      ? newName
      : (nextTable.renamedFrom ?? newName);
    const prior = ownValue(beforeTables, oldName);
    if (!prior) {
      steps.push(...createTableSteps(newName, nextTable));
      createdTables.push([newName, nextTable]);
      continue;
    }
    const tableClaimedBy = claimedOldTables.get(oldName);
    if (tableClaimedBy && tableClaimedBy !== newName) {
      throw new Error(
        `Cannot map deployed table ${oldName} to ${newName} because it is ` +
          `already claimed by ${tableClaimedBy}.`,
      );
    }
    claimedOldTables.set(oldName, newName);
    const tableRenamed = oldName !== newName;
    if (tableRenamed) {
      steps.push({
        description: `Rename table ${oldName} to ${newName}`,
        destructive: false,
        sql: `alter table ${tableName(oldName)} rename to ${qi(newName)}`,
      });
      for (const [oldFieldName, oldField] of Object.entries(prior.fields)) {
        if (oldField.kind === 'enum') {
          steps.push({
            description: `Rebuild enum constraint for renamed table ${newName}.${oldFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} drop constraint if exists ${qi(
              objectName(oldName, oldFieldName, 'enum'),
            )}`,
          });
        }
        if (oldField.kind === 'reference') {
          steps.push({
            description: `Rebuild reference for renamed table ${newName}.${oldFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} drop constraint if exists ${qi(
              objectName(oldName, oldFieldName, 'ref'),
            )}`,
          });
        }
      }
      for (const oldIndex of prior.indexes) {
        steps.push({
          description: `Rebuild index ${newName}.${oldIndex.name} after table rename`,
          destructive: false,
          sql: `drop index if exists ${qi('data')}.${qi(
            indexPhysicalName(oldName, oldIndex),
          )}`,
        });
      }
    }

    const fieldRenameClaims = new Map<string, string>();
    for (const [targetFieldName, field] of Object.entries(nextTable.fields)) {
      const sourceFieldName = field.renamedFrom;
      if (!sourceFieldName || sourceFieldName === targetFieldName) continue;
      if (Object.hasOwn(nextTable.fields, sourceFieldName)) {
        throw new Error(
          `Cannot rename field ${newName}.${sourceFieldName} to ` +
            `${targetFieldName} because the source field is still present in ` +
            'the target schema. Remove the source field entry when declaring ' +
            'the rename.',
        );
      }
      const claimedBy = fieldRenameClaims.get(sourceFieldName);
      if (claimedBy) {
        throw new Error(
          `Cannot rename field ${newName}.${sourceFieldName} to ` +
            `${targetFieldName} because the source field is already claimed by ` +
            `${claimedBy}.`,
        );
      }
      fieldRenameClaims.set(sourceFieldName, targetFieldName);
    }

    const claimedOldFields = new Map<string, string>();
    for (const [newFieldName, nextField] of Object.entries(nextTable.fields)) {
      const declaredOldFieldName = nextField.renamedFrom;
      if (
        declaredOldFieldName &&
        declaredOldFieldName !== newFieldName &&
        ownValue(prior.fields, newFieldName) &&
        ownValue(prior.fields, declaredOldFieldName)
      ) {
        throw new Error(
          `Cannot rename field ${newName}.${declaredOldFieldName} to ` +
            `${newFieldName} because both fields already exist in the deployed ` +
            'schema.',
        );
      }
      const oldFieldName = ownValue(prior.fields, newFieldName)
        ? newFieldName
        : (nextField.renamedFrom ?? newFieldName);
      const priorField = ownValue(prior.fields, oldFieldName);
      if (!priorField) {
        if (!nextField.optional && nextField.default === undefined) {
          throw new Error(
            `Cannot add required field ${newName}.${newFieldName} without a default. ` +
              'Add it as optional or provide a default, deploy, backfill, then make it required.',
          );
        }
        steps.push({
          description: `Add field ${newName}.${newFieldName}`,
          destructive: false,
          sql: `alter table ${tableName(newName)} add column ${fieldDefinition(
            newFieldName,
            nextField,
          )}`,
        });
        const enumCheck = enumConstraint(newName, newFieldName, nextField);
        if (enumCheck) {
          steps.push({
            description: `Validate enum values for ${newName}.${newFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} add ${enumCheck}`,
          });
        }
        const reference = referenceConstraint(newName, newFieldName, nextField);
        if (reference) deferredReferences.push(reference);
        continue;
      }
      const fieldClaimedBy = claimedOldFields.get(oldFieldName);
      if (fieldClaimedBy && fieldClaimedBy !== newFieldName) {
        throw new Error(
          `Cannot map deployed field ${newName}.${oldFieldName} to ` +
            `${newFieldName} because it is already claimed by ` +
            `${fieldClaimedBy}.`,
        );
      }
      claimedOldFields.set(oldFieldName, newFieldName);
      if (oldFieldName !== newFieldName) {
        if (!tableRenamed && priorField.kind === 'enum') {
          steps.push({
            description: `Rebuild enum constraint for renamed field ${newName}.${newFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} drop constraint if exists ${qi(
              objectName(newName, oldFieldName, 'enum'),
            )}`,
          });
        }
        if (!tableRenamed && priorField.kind === 'reference') {
          steps.push({
            description: `Rebuild reference for renamed field ${newName}.${newFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} drop constraint if exists ${qi(
              objectName(newName, oldFieldName, 'ref'),
            )}`,
          });
        }
        steps.push({
          description: `Rename field ${newName}.${oldFieldName} to ${newFieldName}`,
          destructive: false,
          sql: `alter table ${tableName(newName)} rename column ${qi(
            oldFieldName,
          )} to ${qi(newFieldName)}`,
        });
      }
      const altered = alterFieldSteps(
        newName,
        newFieldName,
        priorField,
        nextField,
      );
      steps.push(...altered);
      const constraintRenamed = tableRenamed || oldFieldName !== newFieldName;
      if (
        constraintRenamed &&
        priorField.kind === 'enum' &&
        enumValuesEqual(priorField, nextField)
      ) {
        const enumCheck = enumConstraint(newName, newFieldName, nextField);
        if (enumCheck) {
          steps.push({
            description: `Restore enum constraint for ${newName}.${newFieldName}`,
            destructive: false,
            sql: `alter table ${tableName(newName)} add ${enumCheck}`,
          });
        }
      }
      if (constraintRenamed && altered.length === 0) {
        const reference = referenceConstraint(newName, newFieldName, nextField);
        if (reference) deferredReferences.push(reference);
      }
    }
    for (const oldFieldName of Object.keys(prior.fields)) {
      if (
        !claimedOldFields.has(oldFieldName) &&
        !Object.hasOwn(nextTable.fields, oldFieldName)
      ) {
        steps.push({
          description: `Drop field ${newName}.${oldFieldName}`,
          destructive: true,
          sql: `alter table ${tableName(newName)} drop column ${qi(oldFieldName)}`,
        });
      }
    }

    const beforeIndexes = new Map(
      prior.indexes.map((index) => [index.name, index]),
    );
    const nextIndexes = new Map(
      nextTable.indexes.map((index) => [index.name, index]),
    );
    if (tableRenamed) {
      for (const nextIndex of nextTable.indexes) {
        steps.push(createIndexStep(newName, nextIndex));
      }
      continue;
    }
    for (const [name, oldIndex] of beforeIndexes) {
      const nextIndex = nextIndexes.get(name);
      if (!nextIndex || indexKey(oldIndex) !== indexKey(nextIndex)) {
        steps.push({
          description: `Drop index ${newName}.${name}`,
          destructive: false,
          sql: `drop index if exists ${qi('data')}.${qi(indexPhysicalName(oldName, oldIndex))}`,
        });
      }
    }
    for (const [name, nextIndex] of nextIndexes) {
      const oldIndex = beforeIndexes.get(name);
      if (!oldIndex || indexKey(oldIndex) !== indexKey(nextIndex)) {
        steps.push(createIndexStep(newName, nextIndex));
      }
    }
  }

  // Add references only after every new table exists so forward and cyclic
  // references do not depend on object declaration order in schema.ts.
  for (const [tableNameValue, table] of createdTables) {
    for (const [fieldName, field] of Object.entries(table.fields)) {
      const reference = referenceConstraint(tableNameValue, fieldName, field);
      if (reference) deferredReferences.push(reference);
    }
  }
  steps.push(...deferredReferences);

  for (const oldName of Object.keys(beforeTables)) {
    if (
      !claimedOldTables.has(oldName) &&
      !Object.hasOwn(after.tables, oldName)
    ) {
      steps.push({
        description: `Drop table ${oldName}`,
        destructive: true,
        sql: `drop table ${tableName(oldName)} cascade`,
      });
    }
  }

  const orderedSteps = [
    ...steps.filter((step) => !step.description.startsWith('Add reference ')),
    ...steps.filter((step) => step.description.startsWith('Add reference ')),
  ];
  const fromHash = before ? dataSchemaHash(before) : null;
  const toHash = dataSchemaHash(after);
  const approvalToken = createHash('sha256')
    .update(JSON.stringify({ fromHash, toHash, steps: orderedSteps }))
    .digest('hex');
  return {
    fromHash,
    toHash,
    destructive: orderedSteps.some((step) => step.destructive),
    steps: orderedSteps,
    approvalToken,
  };
}

async function ensureInternalSchema(sql: TransactionSql): Promise<void> {
  await sql.unsafe(`create schema if not exists ${qi('data')}`);
  await sql.unsafe(`create schema if not exists ${qi('_hatch')}`);
  await sql.unsafe(`
    create table if not exists ${qi('_hatch')}.${qi('migrations')} (
      id bigserial primary key,
      deployment_id text not null,
      schema_hash text not null,
      schema_snapshot jsonb not null,
      migration_sql text not null,
      destructive boolean not null default false,
      applied_at timestamptz not null default now()
    )
  `);
  await sql.unsafe(`
    create table if not exists ${qi('_hatch')}.${qi('changes')} (
      seq bigserial primary key,
      table_name text not null,
      row_id text,
      operation text not null,
      created_at timestamptz not null default now()
    )
  `);
  await sql.unsafe(`
    create or replace function ${qi('_hatch')}.${qi('capture_change')}()
    returns trigger language plpgsql as $$
    declare change_seq bigint;
    declare changed_id text;
    begin
      if TG_OP = 'DELETE' then
        changed_id := OLD.id;
      else
        changed_id := NEW.id;
      end if;
      insert into ${qi('_hatch')}.${qi('changes')} (table_name, row_id, operation)
      values (TG_TABLE_NAME, changed_id, lower(TG_OP))
      returning seq into change_seq;
      perform pg_notify('hatch_data_changes', change_seq::text);
      if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
    end $$
  `);
}

export async function currentDataSchema(
  id: string,
): Promise<{ schema: DataSchemaDescriptor; hash: string } | null> {
  const url = await resolveAppDataDatabaseUrl(id);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<
      { schema_snapshot: unknown; schema_hash: string }[]
    >`select schema_snapshot, schema_hash from _hatch.migrations order by id desc limit 1`;
    if (!row) return null;
    return {
      schema: parseDataSchemaDescriptor(row.schema_snapshot),
      hash: row.schema_hash,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function withDataMigrationBarrier<T>(
  id: string,
  missing: T,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  // Callers hold the cross-database cutover lock, so an authoritative "missing"
  // answer cannot race a deploy that provisions the database immediately after
  // this check. An admin lookup also distinguishes a database that never existed
  // from a provisioned database whose connection is currently failing.
  if (!(await appDataDatabaseExists(id))) return missing;

  const url = await resolveAppDataDatabaseUrl(id);
  const sql = postgres(url, {
    max: 1,
    connection: { statement_timeout: 30000 },
    onnotice: () => {},
  });
  try {
    const result = await sql.begin(async (tx) => {
      // Wait for an earlier migration's COMMIT outcome before observing schema
      // state. A plain SELECT can see the old migration row while that COMMIT is
      // still finishing, which is not authoritative enough to clear a fence.
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      return run(tx);
    });
    return result as T;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Drain any in-flight managed migration before a destructive lifecycle action.
 * The caller must hold the App Data cutover lock for the whole operation.
 */
export async function waitForDataMigrationBarrier(id: string): Promise<void> {
  await withDataMigrationBarrier(id, undefined, async () => undefined);
}

/**
 * Resolve the latest committed schema only after every earlier migration has a
 * definitive COMMIT/rollback outcome. Failures are deliberately propagated: a
 * caller must keep its activation fence when this authoritative read is not
 * available.
 */
export async function recoverCurrentDataSchema(
  id: string,
): Promise<{ schema: DataSchemaDescriptor; hash: string } | null> {
  return withDataMigrationBarrier(id, null, async (tx) => {
    const [relation] = await tx<{ exists: boolean }[]>`
      select to_regclass('_hatch.migrations') is not null as exists
    `;
    if (!relation?.exists) return null;
    const [row] = await tx<{ schema_snapshot: unknown; schema_hash: string }[]>`
      select schema_snapshot, schema_hash
      from _hatch.migrations order by id desc limit 1
    `;
    if (!row) return null;
    return {
      schema: parseDataSchemaDescriptor(row.schema_snapshot),
      hash: row.schema_hash,
    };
  });
}

export async function applyDataMigration(options: {
  id: string;
  deploymentId: string;
  schema: DataSchemaDescriptor;
  allowDestructive?: boolean;
  destructiveApprovalToken?: string;
}): Promise<AppliedDataMigration> {
  const url = await ensureAppDataDatabase(options.id);
  const sql = postgres(url, {
    max: 1,
    connection: { statement_timeout: 30000 },
    onnotice: () => {},
  });
  // Set only after every statement in the transaction callback succeeds. If
  // `sql.begin` then rejects, the only remaining ambiguous point is COMMIT.
  let completedAttempt: AppliedDataMigration | undefined;
  try {
    try {
      return await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
        await ensureInternalSchema(tx);
        const [latest] = await tx<
          { schema_snapshot: unknown; schema_hash: string }[]
        >`select schema_snapshot, schema_hash from _hatch.migrations order by id desc limit 1`;
        const before = latest
          ? parseDataSchemaDescriptor(latest.schema_snapshot)
          : null;
        const plan = planDataMigration(before, options.schema);
        if (latest?.schema_hash === plan.toHash) {
          return {
            hash: plan.toHash,
            schema: options.schema,
            plan,
            applied: false,
          };
        }
        if (
          plan.destructive &&
          (!options.allowDestructive ||
            options.destructiveApprovalToken !== plan.approvalToken)
        ) {
          throw new DataMigrationApprovalRequired(plan);
        }
        for (const step of plan.steps) await tx.unsafe(step.sql);
        const migrationSql = plan.steps
          .map((step) => `${step.sql};`)
          .join('\n');
        await tx`
          insert into _hatch.migrations (
            deployment_id, schema_hash, schema_snapshot, migration_sql, destructive
          ) values (
            ${options.deploymentId}, ${plan.toHash},
            ${tx.json(options.schema)}, ${migrationSql}, ${plan.destructive}
          )
        `;
        const [change] = await tx<{ seq: number }[]>`
          insert into _hatch.changes (table_name, row_id, operation)
          values ('*', null, 'schema') returning seq
        `;
        if (change) {
          await tx`select pg_notify('hatch_data_changes', ${String(change.seq)})`;
        }
        completedAttempt = {
          hash: plan.toHash,
          schema: options.schema,
          plan,
          applied: true,
        };
        return completedAttempt;
      });
    } catch (error) {
      if (!completedAttempt?.applied) throw error;

      // A network failure while COMMIT is being acknowledged is ambiguous. Use
      // a fresh connection and the exact deployment id to distinguish a commit
      // from a rollback; checking only the latest hash is insufficient when two
      // deployments target the same schema.
      const verify = postgres(url, {
        max: 1,
        connection: { statement_timeout: 30000 },
        onnotice: () => {},
      });
      let committed: boolean;
      try {
        // The original backend may still be finishing COMMIT after its client
        // connection disappeared. Wait for the same transaction-scoped lock it
        // held before inspecting the row; without this barrier a fresh
        // connection can observe absence, then have the original COMMIT become
        // visible a moment later and incorrectly report a rollback.
        await verify`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
        const [relation] = await verify<{ exists: boolean }[]>`
          select to_regclass('_hatch.migrations') is not null as exists
        `;
        if (!relation?.exists) {
          committed = false;
        } else {
          const [row] = await verify<{ schema_hash: string }[]>`
            select schema_hash from _hatch.migrations
            where deployment_id = ${options.deploymentId}
            order by id desc limit 1
          `;
          committed = row?.schema_hash === completedAttempt.hash;
        }
      } catch {
        throw new DataMigrationOutcomeUnknown(error);
      } finally {
        await verify`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(
          () => {},
        );
        await verify.end({ timeout: 5 }).catch(() => {});
      }
      if (committed) return completedAttempt;
      throw error;
    }
  } finally {
    // Once the transaction result is known, a failure while closing an idle
    // client must not turn a committed migration into a reported failure.
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export const DATA_MIGRATION_LOCK_KEY = MIGRATION_LOCK_KEY;
