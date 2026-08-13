import { validateToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  createRequestEnvTool,
  type EnvBridge,
  type StoredEnvVariable,
} from './request-env';

function resultText(result: { content: { type: string; text?: string }[] }) {
  return result.content.map((part) => part.text ?? '').join('');
}

describe('request_env tool', () => {
  it('returns only final non-secret values from the bridge', async () => {
    const canary = 'secret-canary-never-returned';
    const bridge = vi.fn<EnvBridge>(async () => [
      {
        key: 'SERVICE_TOKEN',
        secret: true,
        value: canary,
      } as unknown as StoredEnvVariable,
      { key: 'ACCOUNT_ID', secret: false, value: 'account-1' },
    ]);
    const tool = createRequestEnvTool(bridge);
    const result = await tool.execute('request', {
      reason: 'Verify a private API.',
      variables: [
        {
          key: 'SERVICE_TOKEN',
          description: 'Read-only API token.',
          secret: true,
        },
        {
          key: 'ACCOUNT_ID',
          description: 'Public account id.',
          secret: true,
        },
      ],
    });

    expect(tool.executionMode).toBe('sequential');
    expect(bridge).toHaveBeenCalledWith(
      'Verify a private API.',
      [
        {
          key: 'SERVICE_TOKEN',
          description: 'Read-only API token.',
          secret: true,
        },
        {
          key: 'ACCOUNT_ID',
          description: 'Public account id.',
          secret: true,
        },
      ],
      undefined,
    );
    expect(resultText(result)).toContain('ACCOUNT_ID: account-1');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.details).toEqual({
      variables: [
        { key: 'SERVICE_TOKEN', secret: true },
        { key: 'ACCOUNT_ID', secret: false, value: 'account-1' },
      ],
      path: '.env',
    });
  });

  it('rejects duplicate and runtime-control keys', async () => {
    const bridge = vi.fn<EnvBridge>(async () => []);
    const tool = createRequestEnvTool(bridge);
    await expect(
      tool.execute('duplicate', {
        reason: 'Need access.',
        variables: [
          { key: 'TOKEN', description: 'First.', secret: true },
          { key: 'TOKEN', description: 'Second.', secret: false },
        ],
      }),
    ).rejects.toThrow(/unique/);
    await expect(
      tool.execute('reserved', {
        reason: 'Need access.',
        variables: [{ key: 'BASH_ENV', description: 'Unsafe.', secret: true }],
      }),
    ).rejects.toThrow(/reserved/);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('requires classifications and exposes no value parameter', () => {
    const tool = createRequestEnvTool(async () => []);
    expect(
      validateToolCall([tool], {
        type: 'toolCall',
        id: 'request',
        name: 'request_env',
        arguments: {
          reason: 'Need access.',
          variables: [
            { key: 'TOKEN', description: 'API token.', secret: true },
          ],
        },
      }),
    ).toEqual({
      reason: 'Need access.',
      variables: [{ key: 'TOKEN', description: 'API token.', secret: true }],
    });
    const schema = tool.parameters as {
      properties: {
        variables: { items: { properties: Record<string, unknown> } };
      };
    };
    expect(schema.properties.variables.items.properties).not.toHaveProperty(
      'value',
    );
    for (const variable of [
      { key: 'TOKEN', description: 'API token.' },
      {
        key: 'TOKEN',
        description: 'API token.',
        secret: true,
        value: 'plaintext',
      },
    ]) {
      expect(() =>
        validateToolCall([tool], {
          type: 'toolCall',
          id: 'request',
          name: 'request_env',
          arguments: { reason: 'Need access.', variables: [variable] },
        }),
      ).toThrow(/Validation failed/);
    }
  });
});
