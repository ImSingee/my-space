import { describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function queryKvTool(platform: PlatformClient) {
  const query = createAppTools({ platform }).find(
    (tool) => tool.name === 'query_app_kv',
  );
  if (!query) throw new Error('Missing query_app_kv tool.');
  return query;
}

describe('query_app_kv', () => {
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
    ]);
    expect(schema.required).toEqual(['id', 'action']);
    expect(schema.properties?.limit?.type).toBe('integer');
  });

  it('validates action-specific fields before calling the platform', async () => {
    const queryAppKv = vi.fn<PlatformClient['queryAppKv']>();
    const query = queryKvTool({ queryAppKv } as unknown as PlatformClient);

    await expect(
      query.execute('missing-key', { id: 'demo-app', action: 'get' }),
    ).rejects.toThrow(/key/);
    await expect(
      query.execute('fractional-limit', {
        id: 'demo-app',
        action: 'list',
        limit: 1.5,
      }),
    ).rejects.toThrow(/expected int/);
    expect(queryAppKv).not.toHaveBeenCalled();
  });

  it('renders list, get, set, and delete results for the model', async () => {
    const queryAppKv = vi
      .fn<PlatformClient['queryAppKv']>()
      .mockResolvedValueOnce({
        action: 'list',
        items: [
          {
            key: 'api-token',
            value: 'plain-secret',
            secret: true,
            createdAt: '2026-07-13T00:00:00.000Z',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
        ],
        nextCursor: 'api-token',
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
    const query = queryKvTool({
      queryAppKv,
    } as unknown as PlatformClient);

    const list = await query.execute('list', {
      id: 'demo-app',
      action: 'list',
      limit: 10,
    });
    expect(toolText(list)).toContain('plain-secret');
    expect(toolText(list)).toContain('Continue with cursor: "api-token"');

    const get = await query.execute('get', {
      id: 'demo-app',
      action: 'get',
      key: 'missing',
    });
    expect(toolText(get)).toBe('KV key "missing" is not set.');

    const set = await query.execute('set', {
      id: 'demo-app',
      action: 'set',
      key: 'mode',
      value: 'production',
    });
    expect(toolText(set)).toContain('"value": "production"');

    const deleted = await query.execute('delete', {
      id: 'demo-app',
      action: 'delete',
      key: 'mode',
    });
    expect(toolText(deleted)).toBe('Deleted KV key "mode" permanently.');

    expect(queryAppKv.mock.calls.map(([id, input]) => [id, input])).toEqual([
      ['demo-app', { action: 'list', limit: 10 }],
      ['demo-app', { action: 'get', key: 'missing' }],
      ['demo-app', { action: 'set', key: 'mode', value: 'production' }],
      ['demo-app', { action: 'delete', key: 'mode' }],
    ]);
  });
});
