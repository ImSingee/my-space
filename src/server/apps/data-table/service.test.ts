import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSchemaDescriptor } from './schema';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  postgres: vi.fn<(url?: unknown, options?: unknown) => unknown>(),
}));

vi.mock('~/db', () => ({
  db: { query: { apps: { findFirst: mocks.findApp } } },
}));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  resolveAppDataDatabaseUrl: () => 'postgres://data:data@127.0.0.1:5432/data',
}));

import { inspectDataTables, mutateDataTable, queryDataTable } from './service';

const APP_ID = '01j00000000000000000000000';
const DEPLOYMENT_ID = '01j00000000000000000000001';
const NOW = new Date('2026-07-13T00:00:00.000Z');

type UnsafeHandler = (
  statement: string,
  params: readonly unknown[] | undefined,
) => Promise<Record<string, unknown>[]>;
type TaggedHandler = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;
type BeginHandler = (...args: unknown[]) => Promise<unknown>;
type EndHandler = () => Promise<void>;

function createHarness(
  schema: DataSchemaDescriptor,
  options: {
    unsafe?: UnsafeHandler;
    events?: string[];
    revision?: string | number;
  } = {},
) {
  const unsafe = vi.fn<UnsafeHandler>(
    options.unsafe ?? (async () => [] as Record<string, unknown>[]),
  );
  const tagged = vi.fn<TaggedHandler>(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim();
      if (statement.includes('pg_try_advisory_xact_lock_shared')) {
        options.events?.push('lock');
        return [{ ok: true }];
      }
      if (
        statement.includes('schema_snapshot') &&
        statement.includes('_hatch.migrations')
      ) {
        return [{ schema_snapshot: schema, schema_hash: 'schema-hash' }];
      }
      if (statement.includes('coalesce(max(seq), 0)::text as revision')) {
        return [{ revision: options.revision ?? '0' }];
      }
      if (
        statement.includes('select id, deployment_id') &&
        statement.includes('_hatch.migrations')
      ) {
        return [];
      }
      throw new Error(`Unexpected tagged SQL in test: ${statement}`);
    },
  );
  const tx = Object.assign(tagged, { unsafe });
  const client = Object.assign(tagged, {
    unsafe,
    begin: vi.fn<BeginHandler>(async (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') {
        throw new TypeError('Transaction callback is missing');
      }
      const result = await callback(tx);
      options.events?.push('transaction-end');
      return result;
    }),
    end: vi.fn<EndHandler>(async () => {}),
  });
  mocks.postgres.mockReturnValue(client);
  return { client, tx, unsafe };
}

function schemaWithFields(
  fields: DataSchemaDescriptor['tables'][string]['fields'],
  indexes: DataSchemaDescriptor['tables'][string]['indexes'] = [],
): DataSchemaDescriptor {
  return {
    version: 1,
    tables: { items: { fields, indexes } },
  };
}

function liveApp(overrides: Record<string, unknown> = {}) {
  return {
    status: 'deployed',
    currentDeploymentId: DEPLOYMENT_ID,
    capabilities: { dataTable: true },
    dataActivationId: null,
    ...overrides,
  };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('managed Data Table service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      'APP_DATABASE_URL',
      'postgres://admin:secret@127.0.0.1:5432/platform',
    );
    vi.stubEnv('APP_URL', 'http://localhost:3700');
    vi.stubEnv('SECRET', 'test-secret');
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map([[APP_ID, Date.now()]]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['query', () => queryDataTable(APP_ID, { table: 'items' })],
    [
      'mutation',
      () =>
        mutateDataTable(APP_ID, {
          operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
        }),
    ],
    ['inspection', () => inspectDataTables(APP_ID)],
  ])('checks the activation fence after locking for %s', async (_name, run) => {
    const events: string[] = [];
    createHarness(schemaWithFields({}), { events });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp({ dataActivationId: 'pending-deployment' });
    });

    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(events).toEqual(['lock', 'platform']);
  });

  it.each([
    [
      'query',
      () =>
        queryDataTable(
          APP_ID,
          { table: 'items' },
          { expectedDeploymentId: 'stale-deployment' },
        ),
    ],
    [
      'mutation',
      () =>
        mutateDataTable(
          APP_ID,
          {
            operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
          },
          { expectedDeploymentId: 'stale-deployment' },
        ),
    ],
  ])('rejects a stale deployment before running a %s', async (_name, run) => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('queries an explicit JSON null separately from SQL NULL', async () => {
    const schema = schemaWithFields(
      { payload: { kind: 'json', optional: true } },
      [{ name: 'by_payload', fields: ['payload'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_payload',
      where: [{ field: 'payload', op: 'eq', value: null }],
      orderBy: { field: 'payload', direction: 'asc' },
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining(
        '("payload" is null or "payload" is not distinct from $1::jsonb)',
      ),
      ['null', 51],
    );
  });

  it('uses indexed equality for JSON null in a required field', async () => {
    const schema = schemaWithFields(
      { payload: { kind: 'json', optional: false } },
      [{ name: 'by_payload', fields: ['payload'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_payload',
      where: [{ field: 'payload', op: 'eq', value: null }],
      orderBy: { field: 'payload', direction: 'asc' },
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('"payload" = $1::jsonb'),
      ['null', 51],
    );
  });

  it('uses a stable sort-value and id keyset cursor', async () => {
    const schema = schemaWithFields(
      { score: { kind: 'integer', optional: false } },
      [{ name: 'by_score', fields: ['score'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-a',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-c',
          score: 11,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.findApp.mockResolvedValue(liveApp());

    const first = await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_score',
      orderBy: { field: 'score', direction: 'asc' },
      limit: 2,
    });

    expect(first.items.map((item) => item.id)).toEqual(['row-a', 'row-b']);
    expect(first.items[0]).not.toHaveProperty('__hatch_cursor_order_is_null');
    expect(decodeCursor(first.cursor!)).toEqual({
      version: 1,
      queryFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      orderField: 'score',
      direction: 'asc',
      value: 10,
      sqlNull: false,
      id: 'row-b',
    });
    expect(unsafe.mock.calls[0]?.[0]).toContain(
      'order by "score" asc, "id" asc limit $1',
    );
    expect(unsafe.mock.calls[0]?.[0]).not.toContain('offset');
    expect(unsafe.mock.calls[0]?.[1]).toEqual([3]);

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_score',
      orderBy: { field: 'score', direction: 'asc' },
      cursor: first.cursor!,
      limit: 2,
    });

    const [statement, params] = unsafe.mock.calls[1] ?? [];
    expect(statement).toContain('"score" > $1');
    expect(statement).toContain('"score" is not distinct from $1');
    expect(statement).toContain('"id" > $2');
    expect(statement).toContain('or "score" is null');
    expect(params).toEqual([10, 'row-b', 3]);
  });

  it('binds a cursor to its table, index, and filters but not its limit', async () => {
    const table = {
      fields: {
        tenant: { kind: 'string' as const, optional: false },
        score: { kind: 'integer' as const, optional: false },
      },
      indexes: [
        {
          name: 'by_tenant_score',
          fields: ['tenant', 'score'],
          unique: false,
        },
        {
          name: 'by_tenant_score_copy',
          fields: ['tenant', 'score'],
          unique: false,
        },
      ],
    } satisfies DataSchemaDescriptor['tables'][string];
    const schema: DataSchemaDescriptor = {
      version: 1,
      tables: { items: table, archivedItems: table },
    };
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-a',
          tenant: 'acme',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          tenant: 'acme',
          score: 11,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ])
      .mockResolvedValue([]);
    mocks.findApp.mockResolvedValue(liveApp());
    const baseQuery = {
      table: 'items',
      index: 'by_tenant_score',
      where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
      orderBy: { field: 'score', direction: 'asc' },
    };

    const first = await queryDataTable(APP_ID, { ...baseQuery, limit: 1 });
    await expect(
      queryDataTable(APP_ID, {
        ...baseQuery,
        cursor: first.cursor!,
        limit: 2,
      }),
    ).resolves.toMatchObject({ items: [] });

    for (const changedQuery of [
      { ...baseQuery, table: 'archivedItems' },
      { ...baseQuery, index: 'by_tenant_score_copy' },
      {
        ...baseQuery,
        where: [{ field: 'tenant', op: 'eq', value: 'other' }],
      },
    ]) {
      await expect(
        queryDataTable(APP_ID, {
          ...changedQuery,
          cursor: first.cursor!,
          limit: 2,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Invalid Data Table cursor.',
      });
    }
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('continues descending pagination after a SQL NULL cursor', async () => {
    const schema = schemaWithFields(
      { score: { kind: 'integer', optional: true } },
      [{ name: 'by_score', fields: ['score'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-b',
          score: null,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: true,
        },
        {
          id: 'row-a',
          score: null,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.findApp.mockResolvedValue(liveApp());

    const first = await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_score',
      orderBy: { field: 'score', direction: 'desc' },
      limit: 1,
    });
    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_score',
      orderBy: { field: 'score', direction: 'desc' },
      cursor: first.cursor!,
      limit: 1,
    });

    const [statement, params] = unsafe.mock.calls[1] ?? [];
    expect(statement).toContain(
      '("score" is not null or ("score" is null and "id" < $1))',
    );
    expect(params).toEqual(['row-b', 2]);
  });

  it('requires a usable B-tree left prefix and ordering shape', async () => {
    const schema = schemaWithFields(
      {
        tenant: { kind: 'string', optional: false },
        score: { kind: 'integer', optional: false },
      },
      [
        {
          name: 'by_tenant_score',
          fields: ['tenant', 'score'],
          unique: false,
        },
      ],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_tenant_score',
      where: [
        { field: 'tenant', op: 'eq', value: 'acme' },
        { field: 'score', op: 'gte', value: 10 },
      ],
      orderBy: { field: 'score', direction: 'desc' },
    });
    expect(unsafe).toHaveBeenCalledOnce();

    for (const query of [
      {
        table: 'items',
        index: 'by_tenant_score',
        where: [{ field: 'score', op: 'eq', value: 10 }],
        orderBy: { field: 'score', direction: 'asc' },
      },
      {
        table: 'items',
        index: 'by_tenant_score',
        where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
      },
      {
        table: 'items',
        index: 'by_tenant_score',
        where: [{ field: 'tenant', op: 'gte', value: 'acme' }],
      },
    ]) {
      await expect(queryDataTable(APP_ID, query)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('preserves single-field index queries with default id ordering', async () => {
    const schema = schemaWithFields(
      { tenant: { kind: 'string', optional: false } },
      [{ name: 'by_tenant', fields: ['tenant'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_tenant',
      where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
    });

    expect(unsafe.mock.calls[0]?.[0]).toContain('order by "id" asc');
  });

  it('accepts equality over a complete non-unique physical index key', async () => {
    const schema = schemaWithFields(
      { tenant: { kind: 'string', optional: false } },
      [{ name: 'by_tenant', fields: ['tenant'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_tenant',
      where: [
        { field: 'tenant', op: 'eq', value: 'acme' },
        { field: 'id', op: 'eq', value: 'row-1' },
      ],
    });

    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('returns revisions above the PostgreSQL int4 range', async () => {
    createHarness(schemaWithFields({}), { revision: '2147483648' });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, { table: 'items' }),
    ).resolves.toMatchObject({ revision: 2_147_483_648 });
  });

  it('accepts a full non-null unique lookup without an id suffix', async () => {
    const schema = schemaWithFields(
      { email: { kind: 'string', optional: false } },
      [{ name: 'by_email', fields: ['email'], unique: true }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      index: 'by_email',
      where: [{ field: 'email', op: 'eq', value: 'person@example.com' }],
    });

    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('rejects a nullable unique lookup that can return multiple SQL NULLs', async () => {
    const schema = schemaWithFields(
      { email: { kind: 'string', optional: true } },
      [{ name: 'by_email', fields: ['email'], unique: true }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, {
        table: 'items',
        index: 'by_email',
        where: [{ field: 'email', op: 'eq', value: null }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('configures a bounded statement timeout for Data DB connections', async () => {
    createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, { table: 'items' });

    expect(mocks.postgres).toHaveBeenCalledWith(expect.any(String), {
      max: 1,
      connection: { statement_timeout: 10_000 },
    });
  });

  it('stores a required JSON default null as JSON null', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: null },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::jsonb)'),
      [expect.any(String), 'null'],
    );
    expect(result.results[0]?.payload).toBeNull();
  });

  it('does not treat an ordinary JSON $hatch key as defaultNow', async () => {
    const payload = { $hatch: 'value', nested: true } as const;
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: payload },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::jsonb)'),
      [expect.any(String), JSON.stringify(payload)],
    );
  });

  it('stores the exact defaultNow marker as ordinary JSON on JSON fields', async () => {
    const payload = { $hatch: 'now' } as const;
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: payload },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::jsonb)'),
      [expect.any(String), JSON.stringify(payload)],
    );
  });

  it('normalizes datetime values before sending them to PostgreSQL', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: NOW,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'insert',
          table: 'items',
          value: { occurredAt: '2026-07-13 08:00:00+08:00' },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::timestamptz)'),
      [expect.any(String), '2026-07-13T00:00:00.000Z'],
    );
  });

  it('stores an optional datetime null as SQL NULL on insert', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'insert',
          table: 'items',
          value: { occurredAt: null },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::timestamptz)'),
      [expect.any(String), null],
    );
    expect(result.results[0]?.occurredAt).toBeNull();
  });

  it('stores an optional datetime null as SQL NULL on patch', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'patch',
          table: 'items',
          id: 'row-1',
          value: { occurredAt: null },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('"occurredAt" = $1::timestamptz'),
      [null, 'row-1'],
    );
    expect(result.results[0]?.occurredAt).toBeNull();
  });

  it('uses SQL NULL when an optional JSON field is omitted', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    const [statement, params] = unsafe.mock.calls[0] ?? [];
    expect(statement).toContain('("id") values ($1)');
    expect(params).toEqual([expect.any(String)]);
  });

  it('unsets an optional JSON field as SQL NULL', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'patch',
          table: 'items',
          id: 'row-1',
          value: {},
          unset: ['payload'],
        },
      ],
    });

    const [statement, params] = unsafe.mock.calls[0] ?? [];
    expect(statement).toContain('"payload" = null');
    expect(statement).not.toContain('"payload" = $1::jsonb');
    expect(params).toEqual(['row-1']);
  });

  it('increments a required numeric field with one SQL expression', async () => {
    const schema = schemaWithFields({
      value: { kind: 'integer', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      revision: '7',
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            value: 3,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'increment',
          table: 'items',
          id: 'row-1',
          field: 'value',
          amount: 2,
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringMatching(
        /^update .* set "value" = "value" \+ \$1, "updated_at" = now\(\)/,
      ),
      [2, 'row-1'],
    );
    expect(result).toEqual({
      results: [
        {
          id: 'row-1',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          value: 3,
        },
      ],
      revision: 7,
    });
  });

  it('returns null when the increment target no longer exists', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ value: { kind: 'number', optional: false } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'increment',
          table: 'items',
          id: 'missing-row',
          field: 'value',
          amount: -0.5,
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(expect.stringMatching(/^update /), [
      -0.5,
      'missing-row',
    ]);
    expect(result.results).toEqual([null]);
  });

  it.each([
    [
      'non-numeric',
      { title: { kind: 'string' as const, optional: false } },
      'title',
      1,
      'Cannot increment non-numeric field "title".',
    ],
    [
      'optional',
      { value: { kind: 'number' as const, optional: true } },
      'value',
      1,
      'Cannot increment optional field "value".',
    ],
    [
      'fractional integer',
      { value: { kind: 'integer' as const, optional: false } },
      'value',
      0.5,
      'Invalid integer field value.',
    ],
  ])(
    'rejects a %s increment before executing SQL',
    async (_case, fields, field, amount, message) => {
      const { unsafe } = createHarness(schemaWithFields(fields));
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        mutateDataTable(APP_ID, {
          operations: [
            {
              type: 'increment',
              table: 'items',
              id: 'row-1',
              field,
              amount,
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 400, message });
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it('rejects incrementing a system-managed field', async () => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'increment',
            table: 'items',
            id: 'row-1',
            field: 'createdAt',
            amount: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Cannot increment system field "createdAt".',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('rejects unsetting a required field', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ title: { kind: 'string', optional: false } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: {},
            unset: ['title'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Cannot unset required field "title".',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('rejects updating and unsetting the same field', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ note: { kind: 'string', optional: true } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: { note: 'Updated' },
            unset: ['note'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Data Table field "note" cannot be both updated and unset.',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it.each(['id', 'createdAt', 'updatedAt'])(
    'rejects the system-managed insert field %s',
    async (field) => {
      const { unsafe } = createHarness(schemaWithFields({}));
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        mutateDataTable(APP_ID, {
          operations: [
            {
              type: 'insert',
              table: 'items',
              value: { [field]: 'caller-controlled' },
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it('does not resolve query names through Object.prototype', async () => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, {
        table: 'items',
        where: [{ field: 'toString', op: 'eq', value: 'x' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('reads estimated counts only after releasing the migration guard', async () => {
    const events: string[] = [];
    const { unsafe } = createHarness(schemaWithFields({}), {
      events,
      unsafe: async (statement) => {
        if (statement.includes('from pg_class')) {
          events.push('estimate');
          return [{ name: 'items', estimated_count: 42.6 }];
        }
        throw new Error(`Unexpected unsafe SQL in test: ${statement}`);
      },
    });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp();
    });

    const result = await inspectDataTables(APP_ID);

    expect(result?.tables).toEqual([{ name: 'items', rowCount: 43 }]);
    expect(events).toEqual(['lock', 'platform', 'transaction-end', 'estimate']);
    expect(unsafe.mock.calls[0]?.[0]).not.toContain('count(*)');
  });

  it('rolls back a patch whose final stored row exceeds the size limit', async () => {
    const value = 'x'.repeat(140 * 1024);
    const schema = schemaWithFields({
      first: { kind: 'string', optional: true },
      second: { kind: 'string', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            first: value,
            second: value,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: { second: value },
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(unsafe).toHaveBeenCalledWith(expect.stringMatching(/^update /), [
      value,
      'row-1',
    ]);
  });

  it('rejects an oversized stored row returned by a query', async () => {
    const value = 'x'.repeat(256 * 1024);
    const { unsafe } = createHarness(
      schemaWithFields({ title: { kind: 'string', optional: false } }),
      {
        unsafe: async () => [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            title: value,
            __hatch_cursor_order_is_null: false,
          },
        ],
      },
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, { table: 'items' }),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Data Table row exceeds 262144 bytes.',
    });
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('handles detached retention failure after a committed mutation', async () => {
    const { client } = createHarness(schemaWithFields({}));
    mocks.postgres.mockReturnValueOnce(client).mockImplementationOnce(() => {
      throw new Error('Data database no longer exists');
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      mutateDataTable(APP_ID, {
        operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
      }),
    ).resolves.toMatchObject({ results: [null] });
    await vi.waitFor(() => expect(mocks.postgres).toHaveBeenCalledTimes(2));
  });
});
