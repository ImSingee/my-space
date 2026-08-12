import { describe, expect, it, vi } from 'vitest';

vi.mock('./provision', () => ({
  appDataDatabaseExists: vi.fn<(id: string) => Promise<boolean>>(),
  ensureAppDataDatabase: vi.fn<(id: string) => Promise<string>>(),
  resolveAppDataDatabaseUrl: vi.fn<(id: string) => Promise<string>>(),
}));

import { planDataMigration } from './migrate';
import type { DataSchemaDescriptor } from './schema';

const initial: DataSchemaDescriptor = {
  version: 1,
  tables: {
    projects: {
      fields: { name: { kind: 'string', optional: false } },
      indexes: [],
    },
    todos: {
      fields: {
        title: { kind: 'string', optional: false },
        projectId: {
          kind: 'reference',
          optional: true,
          referenceTable: 'projects',
        },
      },
      indexes: [{ name: 'by_project', fields: ['projectId'], unique: false }],
    },
  },
};

function withStatusEnum(...enumValues: string[]): DataSchemaDescriptor {
  const schema: DataSchemaDescriptor = structuredClone(initial);
  schema.tables.todos.fields.status = {
    kind: 'enum',
    optional: false,
    enumValues,
  };
  return schema;
}

describe('managed Data Table migration planning', () => {
  it('creates referenced tables before foreign keys', () => {
    const plan = planDataMigration(null, initial);
    const project = plan.steps.findIndex((step) =>
      step.description.includes('Create table projects'),
    );
    const todo = plan.steps.findIndex((step) =>
      step.description.includes('Create table todos'),
    );
    const reference = plan.steps.findIndex((step) =>
      step.description.startsWith('Add reference todos.projectId'),
    );
    expect(project).toBeGreaterThanOrEqual(0);
    expect(todo).toBeGreaterThanOrEqual(0);
    expect(reference).toBeGreaterThan(project);
    expect(reference).toBeGreaterThan(todo);
    expect(plan.destructive).toBe(false);
  });

  it('treats optional/defaulted fields as safe and drops as destructive', () => {
    const expanded: DataSchemaDescriptor = structuredClone(initial);
    expanded.tables.todos.fields.completed = {
      kind: 'boolean',
      optional: false,
      default: false,
    };
    expect(planDataMigration(initial, expanded).destructive).toBe(false);

    const reduced: DataSchemaDescriptor = structuredClone(expanded);
    delete reduced.tables.todos.fields.title;
    const plan = planDataMigration(expanded, reduced);
    expect(plan.destructive).toBe(true);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Drop field todos.title',
          destructive: true,
        }),
      ]),
    );
  });

  it('keeps the defaultNow-shaped JSON value as a JSON default', () => {
    const schema: DataSchemaDescriptor = {
      version: 1,
      tables: {
        events: {
          fields: {
            metadata: {
              kind: 'json',
              optional: false,
              default: { $hatch: 'now' },
            },
          },
          indexes: [],
        },
      },
    };

    const create = planDataMigration(null, schema).steps.find((step) =>
      step.description.includes('Create table events'),
    );
    expect(create?.sql).toContain(`default '{"$hatch":"now"}'::jsonb`);
  });

  it('preserves data for explicit table and field renames', () => {
    const renamed: DataSchemaDescriptor = {
      version: 1,
      tables: {
        tasks: {
          renamedFrom: 'todos',
          fields: {
            label: {
              ...initial.tables.todos.fields.title,
              renamedFrom: 'title',
            },
            projectId: initial.tables.todos.fields.projectId,
          },
          indexes: [
            { name: 'by_project', fields: ['projectId'], unique: false },
          ],
        },
        projects: initial.tables.projects,
      },
    };
    const plan = planDataMigration(initial, renamed);
    expect(plan.destructive).toBe(false);
    expect(plan.steps.map((step) => step.description)).toContain(
      'Rename table todos to tasks',
    );
    expect(plan.steps.map((step) => step.description)).toContain(
      'Rename field tasks.title to label',
    );
    expect(planDataMigration(renamed, renamed).steps).toEqual([]);
  });

  it('adds and removes enum constraints when a field changes kind', () => {
    const plain: DataSchemaDescriptor = structuredClone(initial);
    plain.tables.todos.fields.status = {
      kind: 'string',
      optional: false,
    };
    const enumerated: DataSchemaDescriptor = structuredClone(plain);
    enumerated.tables.todos.fields.status = {
      kind: 'enum',
      optional: false,
      enumValues: ['open', 'done'],
    };

    const entering = planDataMigration(plain, enumerated);
    const changeToEnum = entering.steps.findIndex(
      (step) => step.description === 'Change todos.status from string to enum',
    );
    const addEnumConstraint = entering.steps.findIndex(
      (step) => step.description === 'Validate enum values for todos.status',
    );
    expect(changeToEnum).toBeGreaterThanOrEqual(0);
    expect(addEnumConstraint).toBeGreaterThan(changeToEnum);
    expect(entering.steps[addEnumConstraint]?.sql).toContain(
      'constraint "todos_status_enum" check',
    );

    const leaving = planDataMigration(enumerated, plain);
    const dropEnumConstraint = leaving.steps.findIndex(
      (step) => step.description === 'Remove enum constraint from todos.status',
    );
    const changeFromEnum = leaving.steps.findIndex(
      (step) => step.description === 'Change todos.status from enum to string',
    );
    expect(dropEnumConstraint).toBeGreaterThanOrEqual(0);
    expect(changeFromEnum).toBeGreaterThan(dropEnumConstraint);
    expect(leaving.steps[dropEnumConstraint]?.sql).toContain(
      'drop constraint if exists "todos_status_enum"',
    );
  });

  it('treats enum value additions as non-destructive', () => {
    const plan = planDataMigration(
      withStatusEnum('open'),
      withStatusEnum('open', 'done'),
    );

    expect(plan.destructive).toBe(false);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Replace enum values for todos.status',
          destructive: false,
        }),
      ]),
    );
  });

  it('treats enum value removals as destructive', () => {
    const plan = planDataMigration(
      withStatusEnum('open', 'done'),
      withStatusEnum('open'),
    );

    expect(plan.destructive).toBe(true);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Replace enum values for todos.status',
          destructive: true,
        }),
      ]),
    );
  });

  it('treats enum value replacements as destructive', () => {
    const plan = planDataMigration(
      withStatusEnum('open'),
      withStatusEnum('done'),
    );

    expect(plan.destructive).toBe(true);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Replace enum values for todos.status',
          destructive: true,
        }),
      ]),
    );
  });

  it('drops a reference before changing its column type', () => {
    const withoutReference: DataSchemaDescriptor = structuredClone(initial);
    withoutReference.tables.todos.fields.projectId = {
      kind: 'integer',
      optional: true,
    };

    const plan = planDataMigration(initial, withoutReference);
    const dropReference = plan.steps.findIndex(
      (step) =>
        step.description === 'Replace reference for todos.projectId' &&
        step.sql.includes('drop constraint'),
    );
    const changeType = plan.steps.findIndex(
      (step) =>
        step.description === 'Change todos.projectId from reference to integer',
    );
    expect(dropReference).toBeGreaterThanOrEqual(0);
    expect(changeType).toBeGreaterThan(dropReference);
  });

  it('removes an old default before changing the column type', () => {
    const before: DataSchemaDescriptor = structuredClone(initial);
    before.tables.todos.fields.priority = {
      kind: 'string',
      optional: false,
      default: '1',
    };
    const after: DataSchemaDescriptor = structuredClone(before);
    after.tables.todos.fields.priority = {
      kind: 'integer',
      optional: false,
      default: 1,
    };

    const plan = planDataMigration(before, after);
    const dropDefault = plan.steps.findIndex(
      (step) =>
        step.description ===
        'Remove default for todos.priority before changing type',
    );
    const changeType = plan.steps.findIndex(
      (step) =>
        step.description === 'Change todos.priority from string to integer',
    );
    const setDefault = plan.steps.findIndex(
      (step) => step.description === 'Set default for todos.priority',
    );
    expect(dropDefault).toBeGreaterThanOrEqual(0);
    expect(changeType).toBeGreaterThan(dropDefault);
    expect(setDefault).toBeGreaterThan(changeType);
  });

  it('restores an unchanged enum constraint after a rename with other changes', () => {
    const before: DataSchemaDescriptor = structuredClone(initial);
    before.tables.todos.fields.status = {
      kind: 'enum',
      optional: false,
      enumValues: ['open', 'done'],
    };
    const after: DataSchemaDescriptor = structuredClone(before);
    after.tables.tasks = {
      ...after.tables.todos,
      renamedFrom: 'todos',
      fields: {
        ...after.tables.todos.fields,
        status: {
          ...after.tables.todos.fields.status,
          optional: true,
        },
      },
    };
    delete after.tables.todos;

    const plan = planDataMigration(before, after);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'Allow nulls in tasks.status',
        }),
        expect.objectContaining({
          description: 'Restore enum constraint for tasks.status',
          sql: expect.stringContaining('constraint "tasks_status_enum" check'),
        }),
      ]),
    );
  });

  it('rejects table rename sources that are retained or claimed twice', () => {
    const retained: DataSchemaDescriptor = structuredClone(initial);
    retained.tables.tasks = {
      ...structuredClone(initial.tables.todos),
      renamedFrom: 'todos',
    };
    expect(() => planDataMigration(initial, retained)).toThrow(
      /source table is still present in the target schema/,
    );

    const claimedTwice: DataSchemaDescriptor = structuredClone(initial);
    delete claimedTwice.tables.todos;
    claimedTwice.tables.tasks = {
      ...structuredClone(initial.tables.todos),
      renamedFrom: 'todos',
    };
    claimedTwice.tables.reminders = {
      ...structuredClone(initial.tables.todos),
      renamedFrom: 'todos',
    };
    expect(() => planDataMigration(initial, claimedTwice)).toThrow(
      /source table is already claimed by tasks/,
    );
  });

  it('rejects field rename sources that are retained or claimed twice', () => {
    const retained: DataSchemaDescriptor = structuredClone(initial);
    retained.tables.todos.fields.label = {
      ...initial.tables.todos.fields.title,
      renamedFrom: 'title',
    };
    expect(() => planDataMigration(initial, retained)).toThrow(
      /source field is still present in the target schema/,
    );

    const claimedTwice: DataSchemaDescriptor = structuredClone(initial);
    delete claimedTwice.tables.todos.fields.title;
    claimedTwice.tables.todos.fields.label = {
      ...initial.tables.todos.fields.title,
      renamedFrom: 'title',
    };
    claimedTwice.tables.todos.fields.summary = {
      ...initial.tables.todos.fields.title,
      renamedFrom: 'title',
    };
    expect(() => planDataMigration(initial, claimedTwice)).toThrow(
      /source field is already claimed by label/,
    );
  });

  it('checks for a staged backfill before making an optional field required', () => {
    const before: DataSchemaDescriptor = structuredClone(initial);
    before.tables.todos.fields.title.optional = true;
    const after: DataSchemaDescriptor = structuredClone(before);
    after.tables.todos.fields.title = {
      ...after.tables.todos.fields.title,
      optional: false,
      default: 'Untitled',
    };

    const plan = planDataMigration(before, after);
    const setDefault = plan.steps.findIndex(
      (step) => step.description === 'Set default for todos.title',
    );
    const validate = plan.steps.findIndex(
      (step) => step.description === 'Verify todos.title has no null values',
    );
    const requireField = plan.steps.findIndex(
      (step) => step.description === 'Require todos.title',
    );
    expect(setDefault).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(setDefault);
    expect(requireField).toBeGreaterThan(validate);
    expect(plan.steps[validate]?.sql).toContain(
      'Backfill every row, then deploy this schema again.',
    );
  });

  it('uses collision-resistant physical names for indexes', () => {
    const schema: DataSchemaDescriptor = {
      version: 1,
      tables: {
        a_b: {
          fields: { value: { kind: 'string', optional: false } },
          indexes: [{ name: 'c', fields: ['value'], unique: false }],
        },
        a: {
          fields: { value: { kind: 'string', optional: false } },
          indexes: [{ name: 'b_c', fields: ['value'], unique: false }],
        },
      },
    };

    const indexes = planDataMigration(null, schema).steps.filter((step) =>
      step.description.startsWith('Create index'),
    );
    expect(indexes).toHaveLength(2);
    expect(indexes[0]?.sql.match(/create index "([^"]+)"/)?.[1]).not.toBe(
      indexes[1]?.sql.match(/create index "([^"]+)"/)?.[1],
    );
  });

  it('adds id as a physical tie-breaker only for non-unique indexes', () => {
    const schema: DataSchemaDescriptor = {
      version: 1,
      tables: {
        items: {
          fields: {
            category: { kind: 'string', optional: false },
            externalId: { kind: 'string', optional: false },
          },
          indexes: [
            {
              name: 'by_category',
              fields: ['category'],
              unique: false,
            },
            {
              name: 'by_external_id',
              fields: ['externalId'],
              unique: true,
            },
          ],
        },
      },
    };

    const indexes = planDataMigration(null, schema).steps.filter((step) =>
      step.description.includes('index items.'),
    );
    expect(indexes).toEqual([
      expect.objectContaining({
        description: 'Create index items.by_category',
        sql: expect.stringMatching(/\("category", "id"\)$/),
      }),
      expect.objectContaining({
        description: 'Create unique index items.by_external_id',
        sql: expect.stringMatching(/\("externalId"\)$/),
      }),
    ]);
  });

  it('does not treat inherited names as retained migration objects', () => {
    const after: DataSchemaDescriptor = {
      version: 1,
      tables: {
        items: {
          renamedFrom: 'constructor',
          fields: {
            label: {
              kind: 'string',
              optional: true,
              renamedFrom: 'toString',
            },
          },
          indexes: [],
        },
      },
    };

    expect(() => planDataMigration(null, after)).not.toThrow();
  });

  it('binds destructive approval tokens to the exact source and SQL plan', () => {
    const reduced: DataSchemaDescriptor = structuredClone(initial);
    delete reduced.tables.todos.fields.title;
    const first = planDataMigration(initial, reduced);
    expect(first.destructive).toBe(true);
    expect(planDataMigration(initial, reduced).approvalToken).toBe(
      first.approvalToken,
    );

    const intervening: DataSchemaDescriptor = structuredClone(initial);
    intervening.tables.todos.fields.note = {
      kind: 'string',
      optional: true,
    };
    expect(planDataMigration(intervening, reduced).approvalToken).not.toBe(
      first.approvalToken,
    );
  });
});
