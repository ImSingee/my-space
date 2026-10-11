import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';
import { queryAppKvRequestSchema } from '../protocol';

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function queryKvTool(platform: PlatformClient, sessionId?: string) {
  const query = createAppTools({ platform, sessionId }).find(
    (tool) => tool.name === 'query_app_kv',
  );
  if (!query) throw new Error('Missing query_app_kv tool.');
  return query;
}

describe('query_app_kv', () => {
  it('accepts all optional placeholders and preserves an active empty write', async () => {
    const queryAppKv = vi
      .fn<PlatformClient['queryAppKv']>()
      .mockResolvedValueOnce({ action: 'list', items: [], nextCursor: null })
      .mockResolvedValueOnce({
        action: 'set',
        record: {
          key: 'empty',
          value: '',
          secret: false,
          createdAt: '',
          updatedAt: '',
        },
      });
    const query = queryKvTool({ queryAppKv } as unknown as PlatformClient);
    const placeholders = {
      id: 'sample-app',
      key: '',
      value: '',
      secret: '',
      cursor: '',
      limit: '',
      reveal_secrets: '',
    };
    for (const args of [
      { ...placeholders, action: 'list' },
      { ...placeholders, action: 'set', key: 'empty' },
    ]) {
      const original = structuredClone(args);
      expect(() =>
        validateToolArguments(query, {
          type: 'toolCall',
          id: 'schema',
          name: query.name,
          arguments: args,
        }),
      ).not.toThrow();
      const prepared = query.prepareArguments!(args);
      const validated = validateToolArguments(query, {
        type: 'toolCall',
        id: 'filled',
        name: query.name,
        arguments: prepared as Record<string, unknown>,
      });
      await query.execute('filled', validated);
      expect(args).toEqual(original);
    }
    expect(queryAppKv.mock.calls.map(([, input]) => input)).toEqual([
      { action: 'list', limit: 100, revealSecrets: false },
      { action: 'set', key: 'empty', value: '' },
    ]);
    queryAppKv.mockClear();
    for (const args of [
      { ...placeholders, action: 'get' },
      { ...placeholders, action: 'delete' },
      { ...placeholders, action: 'list', key: 'unexpected' },
      { ...placeholders, action: 'list', unknown: '' },
    ]) {
      await expect(query.execute('invalid', args)).rejects.toThrow(
        /key|unrecognized/i,
      );
    }
    expect(queryAppKv).not.toHaveBeenCalled();
  });
  it('aligns model and runtime cursor bounds without changing first-page requests', async () => {
    const queryAppKv = vi.fn<PlatformClient['queryAppKv']>().mockResolvedValue({
      action: 'list',
      items: [],
      nextCursor: null,
    });
    const query = queryKvTool({ queryAppKv } as unknown as PlatformClient);

    for (const cursor of [
      undefined,
      null,
      '',
      [],
      {},
      0,
      'a',
      'x'.repeat(512),
    ]) {
      const input = {
        action: 'list',
        ...(cursor === undefined ? {} : { cursor }),
      };
      const args = { id: 'sample-app', ...input };
      const prepared = query.prepareArguments!(args) as Record<string, unknown>;
      expect(
        validateToolArguments(query, {
          type: 'toolCall',
          id: 'valid',
          name: query.name,
          arguments: prepared,
        }),
      ).toEqual(prepared);
      await query.execute('valid', args);
      expect(queryAppKv).toHaveBeenLastCalledWith(
        'sample-app',
        queryAppKvRequestSchema.parse({
          action: 'list',
          ...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
        }),
        undefined,
      );
      expect(Object.hasOwn(queryAppKv.mock.lastCall?.[1] ?? {}, 'cursor')).toBe(
        typeof cursor === 'string' && cursor !== '',
      );
      expect(args).toEqual({ id: 'sample-app', ...input });
    }
    queryAppKv.mockClear();
    for (const cursor of ['x'.repeat(513)]) {
      const input = { action: 'list', cursor };
      const args = { id: 'sample-app', ...input };
      expect(() =>
        validateToolArguments(query, {
          type: 'toolCall',
          id: 'invalid',
          name: query.name,
          arguments: args,
        }),
      ).toThrow(/cursor/);
      expect(queryAppKvRequestSchema.safeParse(input).success).toBe(false);
      await expect(query.execute('invalid', args)).rejects.toThrow(/cursor/);
      expect(args).toEqual({ id: 'sample-app', ...input });
    }
    for (const cursor of [123, false, ['nonempty'], { nonempty: true }]) {
      await expect(
        query.execute('invalid-type', {
          id: 'sample-app',
          action: 'list',
          cursor,
        }),
      ).rejects.toThrow(/cursor/);
    }
    expect(queryAppKv).not.toHaveBeenCalled();
  });

  it('uses the returned cursor for the next list without mutating either request', async () => {
    const record = {
      key: 'alpha',
      value: 'one',
      secret: false,
      createdAt: '',
      updatedAt: '',
    };
    const queryAppKv = vi
      .fn<PlatformClient['queryAppKv']>()
      .mockResolvedValueOnce({
        action: 'list',
        items: [record],
        nextCursor: 'alpha',
      })
      .mockResolvedValueOnce({
        action: 'list',
        items: [{ ...record, key: 'beta' }],
        nextCursor: null,
      });
    const query = queryKvTool({ queryAppKv } as unknown as PlatformClient);
    const first = { id: 'sample-app', action: 'list', limit: 1 };
    const result = await query.execute('first', first);
    expect(toolText(result)).toContain('Continue with cursor: "alpha"');
    const second = {
      ...first,
      cursor: (result.details as { nextCursor: string }).nextCursor,
    };
    const last = await query.execute('second', second);
    expect(toolText(last)).toContain('beta');
    expect(toolText(last)).not.toContain('Continue with cursor:');
    expect(queryAppKv.mock.calls.map(([, input]) => input)).toEqual([
      { action: 'list', limit: 1, revealSecrets: false },
      { action: 'list', limit: 1, revealSecrets: false, cursor: 'alpha' },
    ]);
    expect(first).toEqual({ id: 'sample-app', action: 'list', limit: 1 });
    expect(second.cursor).toBe('alpha');
  });

  it('exposes an Anthropic-compatible object root and integer limit', () => {
    const query = queryKvTool({} as PlatformClient);
    const schema = query.parameters as {
      type?: string;
      anyOf?: unknown[];
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };

    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'id',
      'action',
      'key',
      'value',
      'secret',
      'cursor',
      'limit',
      'reveal_secrets',
    ]);
    expect(schema.required).toEqual(['id', 'action']);
    expect(schema.properties?.limit).toMatchObject({
      anyOf: expect.arrayContaining(
        [{ type: 'integer', minimum: 1, maximum: 100 }, { const: '' }].map(
          (member) => expect.objectContaining(member),
        ),
      ),
    });
  });

  it('validates action-specific fields before calling the platform', async () => {
    const queryAppKv = vi.fn<PlatformClient['queryAppKv']>();
    const query = queryKvTool({ queryAppKv } as unknown as PlatformClient);

    await expect(
      query.execute('missing-key', { id: 'immutable-app-id', action: 'get' }),
    ).rejects.toThrow(/key/);
    await expect(
      query.execute('fractional-limit', {
        id: 'immutable-app-id',
        action: 'list',
        limit: 1.5,
      }),
    ).rejects.toThrow(/expected int/);
    await expect(
      query.execute('set-reveal', {
        id: 'immutable-app-id',
        action: 'set',
        key: 'token',
        value: 'value',
        reveal_secrets: true,
      }),
    ).rejects.toThrow(/unrecognized/i);
    await expect(
      query.execute('delete-reveal', {
        id: 'immutable-app-id',
        action: 'delete',
        key: 'token',
        reveal_secrets: true,
      }),
    ).rejects.toThrow(/unrecognized/i);
    expect(queryAppKv).not.toHaveBeenCalled();
  });

  it('renders list, get, set, and delete results for the model', async () => {
    const associateSessionApp = vi.fn<PlatformClient['associateSessionApp']>();
    const queryAppKv = vi
      .fn<PlatformClient['queryAppKv']>()
      .mockResolvedValueOnce({
        action: 'list',
        items: [
          {
            key: 'api-token',
            value: null,
            secret: true,
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        ],
        nextCursor: 'api-token',
      })
      .mockResolvedValueOnce({
        action: 'get',
        record: {
          key: 'api-token',
          value: 'plain-secret',
          secret: true,
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({ action: 'get', record: null })
      .mockResolvedValueOnce({
        action: 'set',
        record: {
          key: 'mode',
          value: 'production',
          secret: false,
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({ action: 'delete', ok: true });
    const query = queryKvTool(
      {
        associateSessionApp,
        queryAppKv,
      } as unknown as PlatformClient,
      'session-one',
    );

    const list = await query.execute('list', {
      id: 'immutable-app-id',
      action: 'list',
      limit: 10,
    });
    expect(toolText(list)).toContain('"value": null');
    expect(toolText(list)).not.toContain('plain-secret');
    expect(toolText(list)).toContain('Continue with cursor: "api-token"');

    const revealed = await query.execute('revealed-get', {
      id: 'immutable-app-id',
      action: 'get',
      key: 'api-token',
      reveal_secrets: true,
    });
    expect(toolText(revealed)).toContain('plain-secret');

    const get = await query.execute('get', {
      id: 'immutable-app-id',
      action: 'get',
      key: 'missing',
    });
    expect(toolText(get)).toBe('KV key "missing" is not set.');

    const set = await query.execute('set', {
      id: 'immutable-app-id',
      action: 'set',
      key: 'mode',
      value: 'production',
    });
    expect(toolText(set)).toContain('"value": "production"');

    const deleted = await query.execute('delete', {
      id: 'immutable-app-id',
      action: 'delete',
      key: 'mode',
    });
    expect(toolText(deleted)).toBe('Deleted KV key "mode" permanently.');

    expect(queryAppKv.mock.calls.map(([id, input]) => [id, input])).toEqual([
      ['immutable-app-id', { action: 'list', limit: 10, revealSecrets: false }],
      [
        'immutable-app-id',
        { action: 'get', key: 'api-token', revealSecrets: true },
      ],
      [
        'immutable-app-id',
        { action: 'get', key: 'missing', revealSecrets: false },
      ],
      [
        'immutable-app-id',
        {
          action: 'set',
          key: 'mode',
          value: 'production',
        },
      ],
      ['immutable-app-id', { action: 'delete', key: 'mode' }],
    ]);
    expect(associateSessionApp).not.toHaveBeenCalled();
  });
});
