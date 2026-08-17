import { describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../platform-client';
import { buildSystemPrompt } from '../system-prompt';
import type { AppDetail } from '../../server/apps/inspect';
import { createAppTools } from './apps';

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function queryDataTableTool(platform: PlatformClient) {
  const query = createAppTools({ platform }).find(
    (tool) => tool.name === 'query_app_data_table',
  );
  if (!query) throw new Error('Missing query_app_data_table tool.');
  return query;
}

function getAppTool(platform: PlatformClient) {
  const getApp = createAppTools({ platform }).find(
    (tool) => tool.name === 'get_app',
  );
  if (!getApp) throw new Error('Missing get_app tool.');
  return getApp;
}

describe('query_app_data_table', () => {
  it('reports a disabled retained Data Table without enabling access', async () => {
    const detail: AppDetail = {
      id: 'demo-app',
      slug: 'demo',
      name: 'Demo',
      description: null,
      status: 'deployed',
      backendMode: null,
      dbName: null,
      dataDbName: 'hatch_data_demo',
      currentVersion: 2,
      currentDeploymentId: 'deployment-v2',
      currentSourceCommit: 'source-v2',
      capabilities: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
      manifest: null,
      ops: {
        backend: { capable: false, mode: null, running: false },
        cron: { enabled: false, jobs: [] },
        webhook: {
          enabled: false,
          url: null,
          hasSecret: false,
          auth: 'platform',
        },
        storage: { enabled: false },
        kv: { enabled: false, url: null, entryCount: 0 },
        dataTable: {
          enabled: false,
          url: null,
          dbName: 'hatch_data_demo',
          schemaHash: '1234567890abcdef',
        },
      },
      deployments: [],
    };
    const getApp = getAppTool({
      getApp: vi.fn<PlatformClient['getApp']>(async () => detail),
    } as unknown as PlatformClient);

    const result = await getApp.execute('get-retained-data', {
      id: 'demo-app',
    });

    expect(toolText(result)).toContain(
      'Data Tables: hatch_data_demo (disabled, retained; 1234567890)',
    );
  });

  it('exposes an Anthropic-compatible object root and bounded integers', () => {
    const query = queryDataTableTool({} as PlatformClient);
    const schema = query.parameters as {
      type?: string;
      anyOf?: unknown[];
      properties?: Record<
        string,
        {
          type?: string;
          minimum?: number;
          maximum?: number;
          maxLength?: number;
          minItems?: number;
          maxItems?: number;
          description?: string;
        }
      >;
      required?: string[];
    };

    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'id',
      'action',
      'table',
      'where',
      'order_by',
      'cursor',
      'limit',
      'operations',
      'sql',
      'timeout_ms',
    ]);
    expect(schema.required).toEqual(['id', 'action']);
    expect(schema.properties?.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
    });
    expect(schema.properties?.operations).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 100,
    });
    expect(schema.properties?.timeout_ms).toMatchObject({
      type: 'integer',
      minimum: 1_000,
      maximum: 1_800_000,
      description:
        'raw_sql only: timeout for the Raw SQL database operation, ' +
        'including statement execution, in milliseconds. It does not cover ' +
        'App resolution or capability preflight. Defaults to 30000.',
    });
    expect(schema.properties?.cursor).toMatchObject({
      type: 'string',
      maxLength: 60_000,
    });
  });

  it('warns that raw SQL is a structured-last data-only fallback', () => {
    const query = queryDataTableTool({} as PlatformClient);

    expect(query.description).toMatch(/structured inspect, query, and mutate/i);
    expect(query.description).toMatch(/dangerous last resort/i);
    expect(query.description).toMatch(/only query or modify rows/i);
    expect(query.description).toMatch(/never use raw_sql for DDL/i);
    expect(query.description).toMatch(/not a runtime SQL restriction/i);
    expect(query.description).toMatch(/Raw SQL database operation only/i);
    expect(query.description).toMatch(
      /does not cover App resolution or capability preflight/i,
    );
    expect(query.description).not.toMatch(/total|whole[- ]call/i);

    const prompt = buildSystemPrompt('https://example.test');
    expect(prompt).toMatch(/query_app_data_table/);
    expect(prompt).toMatch(/raw_sql.*dangerous last resort/is);
    expect(prompt).toMatch(/never use it for DDL/is);
    expect(prompt).toMatch(/does not enforce that SQL rule/is);
  });

  it('validates action-specific fields before calling the platform', async () => {
    const queryAppDataTable = vi.fn<PlatformClient['queryAppDataTable']>();
    const query = queryDataTableTool({
      queryAppDataTable,
    } as unknown as PlatformClient);

    await expect(
      query.execute('query-missing-table', {
        id: 'demo-app',
        action: 'query',
      }),
    ).rejects.toThrow(/table/i);
    await expect(
      query.execute('inspect-with-limit', {
        id: 'demo-app',
        action: 'inspect',
        limit: 10,
      }),
    ).rejects.toThrow(/unrecognized/i);
    await expect(
      query.execute('raw-blank', {
        id: 'demo-app',
        action: 'raw_sql',
        sql: '   ',
      }),
    ).rejects.toThrow(/must not be blank/i);
    await expect(
      query.execute('raw-timeout-too-large', {
        id: 'demo-app',
        action: 'raw_sql',
        sql: 'select 1',
        timeout_ms: 1_800_001,
      }),
    ).rejects.toThrow(/too big|<=1800000/i);
    await expect(
      query.execute('mutate-missing-id', {
        id: 'demo-app',
        action: 'mutate',
        operations: [{ type: 'delete', table: 'todos' }],
      }),
    ).rejects.toThrow(/id/i);
    expect(queryAppDataTable).not.toHaveBeenCalled();
  });

  it('maps snake_case fields and forwards cancellation', async () => {
    const queryAppDataTable = vi
      .fn<PlatformClient['queryAppDataTable']>()
      .mockResolvedValueOnce({
        action: 'query',
        items: [{ id: 'row-1', title: 'First' }],
        cursor: 'next-page',
        revision: 12,
        truncated: false,
      })
      .mockResolvedValueOnce({
        action: 'raw_sql',
        results: [
          {
            command: 'SELECT',
            count: 1,
            rows: [{ count: 3 }],
          },
        ],
        truncated: false,
      });
    const query = queryDataTableTool({
      queryAppDataTable,
    } as unknown as PlatformClient);
    const controller = new AbortController();

    await query.execute(
      'query',
      {
        id: 'demo-app',
        action: 'query',
        table: 'todos',
        where: [{ field: 'completed', op: 'eq', value: false }],
        order_by: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      },
      controller.signal,
    );
    await query.execute('raw', {
      id: 'demo-app',
      action: 'raw_sql',
      sql: 'select count(*) from data.todos',
      timeout_ms: 120_000,
    });

    expect(queryAppDataTable.mock.calls).toEqual([
      [
        'demo-app',
        {
          action: 'query',
          table: 'todos',
          where: [{ field: 'completed', op: 'eq', value: false }],
          orderBy: { field: 'createdAt', direction: 'desc' },
          limit: 25,
        },
        controller.signal,
      ],
      [
        'demo-app',
        {
          action: 'raw_sql',
          sql: 'select count(*) from data.todos',
          timeoutMs: 120_000,
        },
        undefined,
      ],
    ]);
  });

  it('does not echo a supplied cursor when a query returns no rows', async () => {
    const queryAppDataTable = vi
      .fn<PlatformClient['queryAppDataTable']>()
      .mockResolvedValue({
        action: 'query',
        items: [],
        cursor: null,
        revision: 12,
        truncated: false,
      });
    const query = queryDataTableTool({
      queryAppDataTable,
    } as unknown as PlatformClient);

    const result = await query.execute('empty-page', {
      id: 'demo-app',
      action: 'query',
      table: 'todos',
      cursor: 'sensitive-cursor-value',
    });

    expect(toolText(result)).toBe(
      'No Data Table rows found after the provided cursor. Revision: 12.',
    );
    expect(toolText(result)).not.toContain('sensitive-cursor-value');
  });

  it('renders inspection, pagination, mutations, and raw SQL results', async () => {
    const queryAppDataTable = vi
      .fn<PlatformClient['queryAppDataTable']>()
      .mockResolvedValueOnce({ action: 'inspect', data: null })
      .mockResolvedValueOnce({
        action: 'inspect',
        data: {
          schema: { version: 1, tables: {} },
          schemaHash: 'hash',
          tables: [{ name: 'todos', rowCount: 10 }],
          truncated: true,
        },
      })
      .mockResolvedValueOnce({
        action: 'query',
        items: [{ id: 'row-1', title: 'First' }],
        cursor: 'next-page',
        revision: 12,
        truncated: true,
      })
      .mockResolvedValueOnce({
        action: 'mutate',
        results: [{ id: 'row-2', title: 'Created' }, null],
        revision: 13,
      })
      .mockResolvedValueOnce({
        action: 'raw_sql',
        results: [
          {
            command: 'UPDATE',
            count: 2,
            rows: [],
          },
          {
            command: 'SELECT',
            count: 1,
            rows: [{ total: 2 }],
          },
        ],
        truncated: true,
      });
    const query = queryDataTableTool({
      queryAppDataTable,
    } as unknown as PlatformClient);

    const inspection = await query.execute('inspect', {
      id: 'demo-app',
      action: 'inspect',
    });
    expect(toolText(inspection)).toBe(
      'App "demo-app" has no live Data Table schema.',
    );

    const summarizedInspection = await query.execute('inspect-summary', {
      id: 'demo-app',
      action: 'inspect',
    });
    expect(toolText(summarizedInspection)).toContain(
      'Inspect individual tables by passing a table name from data/schema.ts.',
    );

    const rows = await query.execute('query', {
      id: 'demo-app',
      action: 'query',
      table: 'todos',
    });
    expect(toolText(rows)).toContain('"title": "First"');
    expect(toolText(rows)).toContain('Revision: 12.');
    expect(toolText(rows)).toContain('Continue with cursor: "next-page"');
    expect(toolText(rows)).toContain('Output was truncated');

    const mutation = await query.execute('mutate', {
      id: 'demo-app',
      action: 'mutate',
      operations: [
        { type: 'insert', table: 'todos', value: { title: 'Created' } },
      ],
    });
    expect(toolText(mutation)).toContain('"title": "Created"');
    expect(toolText(mutation)).toContain('null');
    expect(toolText(mutation)).toContain('Revision: 13.');
    expect(toolText(mutation)).toContain(
      'No row was found for operation(s): 2.',
    );

    const raw = await query.execute('raw', {
      id: 'demo-app',
      action: 'raw_sql',
      sql: 'update data.todos set completed = true; select count(*) from data.todos',
    });
    expect(toolText(raw)).toContain('"command": "UPDATE"');
    expect(toolText(raw)).toContain('"command": "SELECT"');
    expect(toolText(raw)).toContain('Rerun raw_sql with narrower columns');
    expect(queryAppDataTable).toHaveBeenLastCalledWith(
      'demo-app',
      {
        action: 'raw_sql',
        sql: 'update data.todos set completed = true; select count(*) from data.todos',
        timeoutMs: 30_000,
      },
      undefined,
    );
  });
});
