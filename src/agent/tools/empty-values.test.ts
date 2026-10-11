import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';

describe('optional tool empty values', () => {
  it.each([null, '', [], {}, 0])(
    'makes populated %j controls equivalent to omission before platform calls',
    async (empty) => {
      const queryAppKv = vi
        .fn<PlatformClient['queryAppKv']>()
        .mockResolvedValue({ action: 'list', items: [], nextCursor: null });
      const queryAppDataTable = vi
        .fn<PlatformClient['queryAppDataTable']>()
        .mockImplementation(async (_id, input) =>
          input.action === 'mutate'
            ? { action: 'mutate', results: [], revision: 1 }
            : {
                action: 'query',
                items: [],
                cursor: null,
                revision: 1,
                truncated: false,
              },
        );
      const tools = createAppTools({
        platform: {
          queryAppKv,
          queryAppDataTable,
        } as unknown as PlatformClient,
      });
      const kv = tools.find((t) => t.name === 'query_app_kv')!;
      const data = tools.find((t) => t.name === 'query_app_data_table')!;
      const inputs = [
        {
          tool: kv,
          baseline: { id: 'sample-app', action: 'list' },
          filled: {
            id: 'sample-app',
            action: 'list',
            key: empty,
            value: empty,
            secret: empty,
            cursor: empty,
            limit: empty,
            reveal_secrets: empty,
          },
          calls: queryAppKv,
        },
        {
          tool: data,
          baseline: { id: 'sample-app', action: 'query', table: 'todos' },
          filled: {
            id: 'sample-app',
            action: 'query',
            table: 'todos',
            where: empty,
            order_by: empty,
            cursor: empty,
            limit: empty,
            operations: empty,
            sql: empty,
            timeout_ms: empty,
          },
          calls: queryAppDataTable,
        },
        {
          tool: data,
          baseline: {
            id: 'sample-app',
            action: 'query',
            table: 'todos',
            order_by: { field: 'title' },
          },
          filled: {
            id: 'sample-app',
            action: 'query',
            table: 'todos',
            order_by: { field: 'title', direction: empty },
          },
          calls: queryAppDataTable,
        },
        {
          tool: data,
          baseline: {
            id: 'sample-app',
            action: 'mutate',
            operations: [{ type: 'insert', table: 'todos', value: {} }],
          },
          filled: {
            id: 'sample-app',
            action: 'mutate',
            operations: [
              {
                type: 'insert',
                table: 'todos',
                value: {},
                id: empty,
                field: empty,
                amount: empty,
                unset: empty,
              },
            ],
            table: empty,
            where: empty,
            order_by: empty,
            cursor: empty,
            limit: empty,
            sql: empty,
            timeout_ms: empty,
          },
          calls: queryAppDataTable,
        },
      ];
      for (const { tool, baseline, filled, calls } of inputs) {
        await tool.execute('omitted', baseline);
        const omittedCall = structuredClone(calls.mock.lastCall);
        const original = structuredClone(filled);
        expect(() =>
          validateToolArguments(tool, {
            type: 'toolCall',
            id: 'schema',
            name: tool.name,
            arguments: filled,
          }),
        ).not.toThrow();
        const prepared = tool.prepareArguments!(filled) as Record<
          string,
          unknown
        >;
        await tool.execute(
          'filled',
          validateToolArguments(tool, {
            type: 'toolCall',
            id: 'filled',
            name: tool.name,
            arguments: prepared,
          }),
        );
        expect(calls.mock.lastCall).toEqual(omittedCall);
        expect(filled).toEqual(original);
      }
    },
  );

  it('preserves valid enum values and nonempty string zero outside enums through provider validation', async () => {
    const queryAppDataTable = vi
      .fn<PlatformClient['queryAppDataTable']>()
      .mockResolvedValue({
        action: 'query',
        items: [],
        cursor: null,
        revision: 1,
        truncated: false,
      });
    const data = createAppTools({
      platform: { queryAppDataTable } as unknown as PlatformClient,
    }).find((tool) => tool.name === 'query_app_data_table')!;
    const args = {
      id: 'sample-app',
      action: 'query',
      table: 'todos',
      cursor: '0',
      order_by: { field: 'title', direction: 'desc' },
    };
    await data.execute(
      'valid',
      validateToolArguments(data, {
        type: 'toolCall',
        id: 'valid',
        name: data.name,
        arguments: data.prepareArguments!(args) as Record<string, unknown>,
      }),
    );
    expect(queryAppDataTable.mock.lastCall?.[1]).toEqual({
      action: 'query',
      table: 'todos',
      where: [],
      limit: 50,
      cursor: '0',
      orderBy: { field: 'title', direction: 'desc' },
    });
  });

  it('keeps required empty data and explicit false, and rejects nonempty wrong types', async () => {
    const queryAppKv = vi.fn<PlatformClient['queryAppKv']>().mockResolvedValue({
      action: 'set',
      record: {
        key: 'empty',
        value: '',
        secret: false,
        createdAt: '',
        updatedAt: '',
      },
    });
    const queryAppDataTable = vi
      .fn<PlatformClient['queryAppDataTable']>()
      .mockResolvedValue({ action: 'mutate', results: [], revision: 1 });
    const tools = createAppTools({
      platform: { queryAppKv, queryAppDataTable } as unknown as PlatformClient,
    });
    const kv = tools.find((t) => t.name === 'query_app_kv')!;
    const data = tools.find((t) => t.name === 'query_app_data_table')!;
    await kv.execute('empty-write', {
      id: 'sample-app',
      action: 'set',
      key: 'empty',
      value: '',
      secret: false,
    });
    expect(queryAppKv).toHaveBeenLastCalledWith(
      'sample-app',
      { action: 'set', key: 'empty', value: '', secret: false },
      undefined,
    );
    const value = {
      text: '',
      nullable: null,
      list: [],
      object: {},
      zero: 0,
      flag: false,
    };
    await data.execute('data', {
      id: 'sample-app',
      action: 'mutate',
      operations: [
        { type: 'insert', table: 'todos', value },
        {
          type: 'increment',
          table: 'stats',
          id: 'row-1',
          field: 'count',
          amount: 0,
        },
      ],
    });
    expect(queryAppDataTable.mock.lastCall?.[1]).toEqual({
      action: 'mutate',
      operations: [
        { type: 'insert', table: 'todos', value },
        {
          type: 'increment',
          table: 'stats',
          id: 'row-1',
          field: 'count',
          amount: 0,
        },
      ],
    });
    queryAppKv.mockClear();
    queryAppDataTable.mockClear();
    for (const args of [
      { id: 'sample-app', action: 'query', table: 'todos', where: false },
      { id: 'sample-app', action: 'query', table: 'todos', limit: false },
      { id: 'sample-app', action: 'inspect', unknown: null },
      { id: 'sample-app', action: 'inspect', cursor: 'wrong-action' },
      {
        id: 'sample-app',
        action: 'mutate',
        operations: [
          {
            type: 'increment',
            table: 'stats',
            id: 'row-1',
            field: 'count',
            amount: null,
          },
        ],
      },
    ]) {
      await expect(data.execute('invalid', args)).rejects.toThrow(
        /where|limit|amount|declared|unrecognized|cursor/i,
      );
    }
    for (const value of [null, [], {}, 0]) {
      await expect(
        kv.execute('invalid-data', {
          id: 'sample-app',
          action: 'set',
          key: 'empty',
          value,
        }),
      ).rejects.toThrow(/value/i);
    }
    expect(queryAppKv).not.toHaveBeenCalled();
    expect(queryAppDataTable).not.toHaveBeenCalled();
  });

  it.each([null, '', [], {}, 0])(
    'gives the same required-field errors for omission and %j',
    async (empty) => {
      const queryAppKv = vi.fn<PlatformClient['queryAppKv']>();
      const queryAppDataTable = vi.fn<PlatformClient['queryAppDataTable']>();
      const tools = createAppTools({
        platform: {
          queryAppKv,
          queryAppDataTable,
        } as unknown as PlatformClient,
      });
      for (const [name, args, field] of [
        ['query_app_kv', { id: 'sample-app', action: 'get' }, 'key'],
        ['query_app_kv', { id: 'sample-app', action: 'delete' }, 'key'],
        [
          'query_app_data_table',
          { id: 'sample-app', action: 'query' },
          'table',
        ],
        [
          'query_app_data_table',
          { id: 'sample-app', action: 'mutate' },
          'operations',
        ],
      ] as const) {
        const tool = tools.find((t) => t.name === name)!;
        const omittedError = await tool
          .execute('omitted', args)
          .catch((error: Error) => error.message);
        const emptyError = await tool
          .execute('empty', { ...args, [field]: empty })
          .catch((error: Error) => error.message);
        expect(omittedError).toEqual(expect.any(String));
        expect(emptyError).toEqual(omittedError);
      }
      expect(queryAppKv).not.toHaveBeenCalled();
      expect(queryAppDataTable).not.toHaveBeenCalled();
    },
  );
});
