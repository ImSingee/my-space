import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSchemaDescriptor } from './data-table/schema';

const mocks = vi.hoisted(() => ({
  assertAccess: vi.fn<(...args: unknown[]) => Promise<void>>(),
  executeRaw: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  inspect: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mutate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  query: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('./data-table/service', () => ({
  assertDataTableAccess: mocks.assertAccess,
  DATA_AGENT_RESULT_MAX_CHARS: 60_000,
  executeDataTableRawSql: mocks.executeRaw,
  inspectDataTables: mocks.inspect,
  mutateDataTable: mocks.mutate,
  queryDataTable: mocks.query,
}));

const { queryAppDataTable } = await import('./query-data-table');

const schema: DataSchemaDescriptor = {
  version: 1,
  tables: {
    items: { fields: {}, indexes: [] },
    notes: { fields: {}, indexes: [] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertAccess.mockResolvedValue();
});

describe('queryAppDataTable', () => {
  it('checks the live capability fence before opening the Data DB', async () => {
    mocks.assertAccess.mockRejectedValue(
      Object.assign(new Error('Data Table is not available.'), { status: 404 }),
    );

    await expect(
      queryAppDataTable('app', { action: 'inspect' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('returns only the requested inspection table and hides migrations', async () => {
    mocks.inspect.mockResolvedValue({
      schema,
      schemaHash: 'hash',
      tables: [
        { name: 'items', rowCount: 3 },
        { name: 'notes', rowCount: 4 },
      ],
      migrations: [{ sql: 'secret physical history' }],
    });

    await expect(
      queryAppDataTable('app', { action: 'inspect', table: 'notes' }),
    ).resolves.toEqual({
      action: 'inspect',
      data: {
        schema: {
          version: 1,
          tables: { notes: { fields: {}, indexes: [] } },
        },
        schemaHash: 'hash',
        tables: [{ name: 'notes', rowCount: 4 }],
      },
    });
  });

  it('rejects an unknown inspection table', async () => {
    mocks.inspect.mockResolvedValue({
      schema,
      schemaHash: 'hash',
      tables: [],
      migrations: [],
    });

    await expect(
      queryAppDataTable('app', { action: 'inspect', table: 'missing' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('summarizes an oversized full inspection for table-by-table follow-up', async () => {
    const largeSchema: DataSchemaDescriptor = {
      version: 1,
      tables: Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `table${index}`,
          {
            fields: {
              description: {
                kind: 'string' as const,
                optional: false,
                default: 'x'.repeat(100),
              },
            },
            indexes: [],
          },
        ]),
      ),
    };
    mocks.inspect.mockResolvedValue({
      schema: largeSchema,
      schemaHash: 'hash',
      tables: Object.keys(largeSchema.tables).map((name) => ({
        name,
        rowCount: 0,
      })),
      migrations: [],
    });

    const result = await queryAppDataTable('app', { action: 'inspect' });

    expect(result).toMatchObject({
      action: 'inspect',
      data: {
        schema: { version: 1, tables: {} },
        schemaHash: 'hash',
        truncated: true,
      },
    });
    expect(JSON.stringify(result, null, 2).length).toBeLessThan(60_000);
  });

  it('rejects one table whose schema alone exceeds the output budget', async () => {
    const largeTable = {
      fields: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `field${index}`,
          {
            kind: 'string' as const,
            optional: false,
            default: 'x'.repeat(100),
          },
        ]),
      ),
      indexes: [],
    };
    mocks.inspect.mockResolvedValue({
      schema: { version: 1, tables: { huge: largeTable } },
      schemaHash: 'hash',
      tables: [{ name: 'huge', rowCount: 0 }],
      migrations: [],
    });

    await expect(
      queryAppDataTable('app', { action: 'inspect', table: 'huge' }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('applies the Agent result budget to structured queries', async () => {
    mocks.query.mockResolvedValue({
      items: [{ id: 'row-1' }],
      cursor: 'cursor',
      revision: 2,
      truncated: true,
    });

    await expect(
      queryAppDataTable('app', {
        action: 'query',
        table: 'items',
        where: [],
        limit: 50,
      }),
    ).resolves.toEqual({
      action: 'query',
      items: [{ id: 'row-1' }],
      cursor: 'cursor',
      revision: 2,
      truncated: true,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      'app',
      { table: 'items', where: [], limit: 50 },
      { resultMaxChars: 60_000 },
    );
  });

  it('applies the Agent result budget before structured mutations commit', async () => {
    mocks.mutate.mockResolvedValue({
      results: [{ id: 'row-1' }],
      revision: 3,
    });

    await queryAppDataTable('app', {
      action: 'mutate',
      operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
    });

    expect(mocks.mutate).toHaveBeenCalledWith(
      'app',
      {
        operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
      },
      { resultMaxChars: 60_000 },
    );
  });

  it('forwards raw SQL, custom timeout, and cancellation unchanged', async () => {
    mocks.executeRaw.mockResolvedValue({ results: [], truncated: false });
    const abort = new AbortController();

    await expect(
      queryAppDataTable(
        'app',
        {
          action: 'raw_sql',
          sql: 'select 1; update items set updated_at = now()',
          timeoutMs: 90_000,
        },
        abort.signal,
      ),
    ).resolves.toEqual({
      action: 'raw_sql',
      results: [],
      truncated: false,
    });
    expect(mocks.executeRaw).toHaveBeenCalledWith(
      'app',
      'select 1; update items set updated_at = now()',
      90_000,
      abort.signal,
    );
  });
});
