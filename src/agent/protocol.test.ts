import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { APP_NAME_MAX_LENGTH, APP_SLUG_MAX_LENGTH } from '~/app-identity';
import {
  createAppForSessionRequestSchema,
  createAppRequestSchema,
  deploySourceRequestSchema,
  isSafeRelativePath,
  parseHubMessage,
  parseRunnerMessage,
  PROTOCOL_VERSION,
  QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
  queryAppDataTableRequestSchema,
  queryAppKvRequestSchema,
  scaffoldFileSchema,
} from './protocol';

describe('App creation payload', () => {
  it('accepts Unicode names and slugs at the 64-character boundary', () => {
    const name = '😀'.repeat(APP_NAME_MAX_LENGTH);
    const slug = `a${'b'.repeat(APP_SLUG_MAX_LENGTH - 1)}`;

    expect(createAppRequestSchema.parse({ name, slug })).toMatchObject({
      name,
      slug,
    });
  });

  it('rejects names and slugs above the 64-character boundary', () => {
    const validName = '😀'.repeat(APP_NAME_MAX_LENGTH);
    const validSlug = `a${'b'.repeat(APP_SLUG_MAX_LENGTH - 1)}`;

    expect(
      createAppRequestSchema.safeParse({
        name: `${validName}😀`,
        slug: validSlug,
      }).success,
    ).toBe(false);
    expect(
      createAppRequestSchema.safeParse({
        name: validName,
        slug: `${validSlug}b`,
      }).success,
    ).toBe(false);
  });

  it('requires Runner-owned session identity on the internal create payload', () => {
    expect(
      createAppForSessionRequestSchema.parse({
        slug: 'created-app',
        name: 'Created App',
        sessionId: 'session-one',
      }),
    ).toMatchObject({ sessionId: 'session-one' });
    expect(
      createAppForSessionRequestSchema.safeParse({
        slug: 'created-app',
        name: 'Created App',
      }).success,
    ).toBe(false);
  });
});

describe('runner -> platform messages', () => {
  it('uses protocol v12 for Platform-owned beta feature delivery', () => {
    expect(PROTOCOL_VERSION).toBe(13);
  });

  it('parses runner.hello', () => {
    const message = parseRunnerMessage({
      type: 'runner.hello',
      runnerId: 'runner-1',
      protocolVersion: 1,
      activeRunIds: ['a', 'b'],
      workspaceSessionIds: ['s1'],
    });
    if (message.type !== 'runner.hello') throw new Error('wrong type');
    expect(message.activeRunIds).toEqual(['a', 'b']);
    expect(message.workspaceSessionIds).toEqual(['s1']);
  });

  it('parses runner.ready', () => {
    expect(parseRunnerMessage({ type: 'runner.ready' })).toEqual({
      type: 'runner.ready',
    });
  });

  it('parses run.event and preserves the stream payload', () => {
    const message = parseRunnerMessage({
      type: 'run.event',
      runId: 'r1',
      runnerSeq: 7,
      event: { type: 'text', delta: 'hi' },
    });
    if (message.type !== 'run.event') throw new Error('wrong type');
    expect(message.runnerSeq).toBe(7);
    expect(message.event).toEqual({ type: 'text', delta: 'hi' });
  });

  it('parses structured details on a tool-start event', () => {
    const message = parseRunnerMessage({
      type: 'run.event',
      runId: 'r1',
      runnerSeq: 8,
      event: {
        type: 'tool_start',
        id: 'tool-1',
        name: 'read_file',
        args: { path: 'src/app.ts' },
        details: {
          relativePath: 'src/app.ts',
          absolutePath: '/runner/work/src/app.ts',
        },
      },
    });

    expect(message).toMatchObject({
      event: {
        type: 'tool_start',
        details: {
          relativePath: 'src/app.ts',
          absolutePath: '/runner/work/src/app.ts',
        },
      },
    });
  });

  it('parses run.finished with and without error', () => {
    const ok = parseRunnerMessage({
      type: 'run.finished',
      runId: 'r1',
      status: 'completed',
      messages: [{ role: 'assistant' }],
    });
    if (ok.type !== 'run.finished') throw new Error('wrong type');
    expect(ok.error).toBeUndefined();

    const failed = parseRunnerMessage({
      type: 'run.finished',
      runId: 'r1',
      status: 'failed',
      error: 'boom',
      messages: [],
    });
    if (failed.type !== 'run.finished') throw new Error('wrong type');
    expect(failed.error).toBe('boom');
  });

  it('strictly validates safe environment events', () => {
    expect(
      parseRunnerMessage({
        type: 'run.event',
        runId: 'r1',
        runnerSeq: 1,
        event: {
          type: 'env_request',
          requestId: 'env-1',
          reason: 'Deploy to the service',
          variables: [
            {
              key: 'SERVICE_TOKEN',
              description: 'Service API token',
              secret: true,
            },
          ],
        },
      }),
    ).toMatchObject({
      event: { type: 'env_request', requestId: 'env-1' },
    });
    expect(
      parseRunnerMessage({
        type: 'run.event',
        runId: 'r1',
        runnerSeq: 2,
        event: {
          type: 'env_stored',
          requestId: 'env-1',
          variables: [{ key: 'SERVICE_TOKEN', secret: true }],
        },
      }),
    ).toMatchObject({
      event: {
        type: 'env_stored',
        variables: [{ key: 'SERVICE_TOKEN', secret: true }],
      },
    });

    for (const event of [
      {
        type: 'env_request',
        requestId: 'env-1',
        reason: 'Need it',
        variables: [
          {
            key: 'TOKEN',
            description: 'Token',
            secret: true,
            value: 'plaintext',
          },
        ],
      },
      {
        type: 'env_request',
        requestId: 'env-1',
        reason: 'Need it',
        variables: [],
      },
      {
        type: 'env_stored',
        requestId: 'env-1',
        variables: [{ key: 'TOKEN', secret: true }],
        value: 'plaintext',
      },
    ]) {
      expect(() =>
        parseRunnerMessage({
          type: 'run.event',
          runId: 'r1',
          runnerSeq: 3,
          event,
        }),
      ).toThrow(ZodError);
    }
  });

  it('rejects unknown stream events and extra fields before persistence', () => {
    const canary = 'plaintext-canary-must-not-persist';
    for (const event of [
      { type: 'text', delta: 'safe', value: canary },
      {
        type: 'run.env',
        entries: [{ key: 'TOKEN', value: canary, secret: true }],
      },
    ]) {
      expect(() =>
        parseRunnerMessage({
          type: 'run.event',
          runId: 'r1',
          runnerSeq: 3,
          event,
        }),
      ).toThrow(ZodError);
    }
  });

  it('requires a safe run.env_result shape', () => {
    expect(
      parseRunnerMessage({
        type: 'run.env_result',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-1',
        ok: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseRunnerMessage({
        type: 'run.env_result',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-2',
        ok: false,
        errorCode: 'write_failed',
      }),
    ).toMatchObject({ ok: false, errorCode: 'write_failed' });
    expect(() =>
      parseRunnerMessage({
        type: 'run.env_result',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-3',
        ok: false,
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseRunnerMessage({
        type: 'run.env_result',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-4',
        ok: true,
        errorCode: 'plaintext',
      }),
    ).toThrow(ZodError);
  });

  it('rejects unknown message types and bad payloads', () => {
    expect(() => parseRunnerMessage({ type: 'nope' })).toThrow(ZodError);
    expect(() =>
      parseRunnerMessage({ type: 'run.event', runId: '', runnerSeq: 1 }),
    ).toThrow(ZodError);
    expect(() =>
      parseRunnerMessage({
        type: 'run.event',
        runId: 'r1',
        runnerSeq: 0, // must be positive
        event: { type: 'text', delta: 'x' },
      }),
    ).toThrow(ZodError);
  });
});

describe('platform -> runner messages', () => {
  it('parses the Platform beta features in hub.hello_ack', () => {
    expect(
      parseHubMessage({
        type: 'hub.hello_ack',
        betaFeatures: ['workflow', 'future-feature'],
        resumedRunIds: [],
        staleRunIds: [],
        staleWorkspaceSessionIds: [],
      }),
    ).toEqual({
      type: 'hub.hello_ack',
      betaFeatures: ['workflow', 'future-feature'],
      resumedRunIds: [],
      staleRunIds: [],
      staleWorkspaceSessionIds: [],
    });
  });

  it('parses hub.ready_ack', () => {
    expect(parseHubMessage({ type: 'hub.ready_ack' })).toEqual({
      type: 'hub.ready_ack',
    });
  });

  it('parses run.start with model config', () => {
    const message = parseHubMessage({
      type: 'run.start',
      runId: 'r1',
      sessionId: 's1',
      userText: 'hello',
      composerContent: [{ type: 'text', text: 'hello' }],
      images: [],
      attachments: [],
      priorMessages: [],
      model: {
        providerId: 'p1',
        providerName: 'Test',
        apiType: 'anthropic-messages',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: {
          id: 'm1',
          name: 'Model One',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      },
    });
    if (message.type !== 'run.start') throw new Error('wrong type');
    expect(message.model.model.id).toBe('m1');
    expect(message.composerContent).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('parses run.answer and defaults selectedOptionIds', () => {
    const message = parseHubMessage({
      type: 'run.answer',
      runId: 'r1',
      askId: 'ask1',
      answers: [{ questionId: 'q1', customText: 'free text' }],
    });
    if (message.type !== 'run.answer') throw new Error('wrong type');
    expect(message.answers[0].selectedOptionIds).toEqual([]);
    expect(message.answers[0].customText).toBe('free text');
  });

  it('strictly validates transient run.env entries and classifications', () => {
    const message = parseHubMessage({
      type: 'run.env',
      runId: 'r1',
      requestId: 'secret-1',
      deliveryId: 'delivery-1',
      entries: [{ key: 'SERVICE_TOKEN', value: 'token-value', secret: true }],
    });
    if (message.type !== 'run.env') throw new Error('wrong type');
    expect(message.entries).toEqual([
      { key: 'SERVICE_TOKEN', value: 'token-value', secret: true },
    ]);

    for (const entries of [
      [{ key: 'SERVICE-TOKEN', value: 'token-value', secret: true }],
      [{ key: 'SERVICE_TOKEN', value: 'line one\nline two', secret: true }],
      [
        { key: 'SERVICE_TOKEN', value: 'first', secret: true },
        { key: 'SERVICE_TOKEN', value: 'second', secret: false },
      ],
      [{ key: 'SERVICE_TOKEN', value: '😀'.repeat(4097), secret: true }],
      [{ key: 'SERVICE_TOKEN', value: 'malformed\ud800value', secret: true }],
      [{ key: 'SERVICE_TOKEN', value: 'token-value', secret: 'yes' }],
      [
        {
          key: 'SERVICE_TOKEN',
          value: 'token-value',
          secret: true,
          extra: 'nope',
        },
      ],
    ]) {
      expect(() =>
        parseHubMessage({
          type: 'run.env',
          runId: 'r1',
          requestId: 'secret-1',
          deliveryId: 'delivery-invalid',
          entries,
        }),
      ).toThrow(ZodError);
    }
    expect(() =>
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-extra',
        entries: [{ key: 'SERVICE_TOKEN', value: 'ok', secret: true }],
        plaintext: 'nope',
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-emoji',
        entries: [
          { key: 'SERVICE_TOKEN', value: '😀'.repeat(4096), secret: false },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-empty-and-unquoted',
        entries: [
          { key: 'EMPTY', value: '', secret: true },
          { key: 'ALL_QUOTES', value: 'a\'"`b', secret: false },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        entries: [{ key: 'SERVICE_TOKEN', value: 'ok', secret: true }],
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-reserved',
        entries: [{ key: 'HOME', value: 'ok', secret: true }],
      }),
    ).toThrow(ZodError);

    const canary = 'plaintext-canary\ud800';
    let parseError: unknown;
    try {
      parseHubMessage({
        type: 'run.env',
        runId: 'r1',
        requestId: 'secret-1',
        deliveryId: 'delivery-malformed',
        entries: [{ key: 'SERVICE_TOKEN', value: canary, secret: true }],
      });
    } catch (error) {
      parseError = error;
    }
    expect(parseError).toBeInstanceOf(ZodError);
    expect(JSON.stringify(parseError)).not.toContain('plaintext-canary');
  });

  it('rejects a runner message on the hub channel', () => {
    expect(() => parseHubMessage({ type: 'runner.ping' })).toThrow(ZodError);
  });

  it('accepts only whole-session workspace cleanup', () => {
    expect(
      parseHubMessage({
        type: 'workspace.cleanup',
        scope: 'session',
        sessionId: 'session-a',
      }),
    ).toEqual({
      type: 'workspace.cleanup',
      scope: 'session',
      sessionId: 'session-a',
    });
    expect(() =>
      parseHubMessage({
        type: 'workspace.cleanup',
        scope: 'workflow',
        id: 'workflow-a',
        generation: '2026-07-12T00:00:00.000Z',
      }),
    ).toThrow(ZodError);
  });
});

describe('scaffold file safety', () => {
  it('accepts normal relative paths', () => {
    expect(isSafeRelativePath('manifest.json')).toBe(true);
    expect(isSafeRelativePath('app/src/main.tsx')).toBe(true);
    expect(isSafeRelativePath('.gitignore')).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('../outside')).toBe(false);
    expect(isSafeRelativePath('a/../../outside')).toBe(false);
    expect(isSafeRelativePath('a/./b')).toBe(false);
    expect(isSafeRelativePath('a//b')).toBe(false);
    expect(isSafeRelativePath('a\\b')).toBe(false);
    expect(isSafeRelativePath('a\0b')).toBe(false);
  });

  it('scaffoldFileSchema enforces the path check', () => {
    expect(
      scaffoldFileSchema.safeParse({ path: '../x', contentBase64: '' }).success,
    ).toBe(false);
    expect(
      scaffoldFileSchema.safeParse({ path: 'x.txt', contentBase64: 'aGk=' })
        .success,
    ).toBe(true);
  });
});

describe('deploy source requests', () => {
  it('requires the entity generation observed by the runner', () => {
    expect(
      deploySourceRequestSchema.safeParse({
        message: 'Deploy current source',
        generation: '2026-07-12T00:00:00.000Z',
        bundleBase64: 'bundle',
      }).success,
    ).toBe(true);
    expect(
      deploySourceRequestSchema.safeParse({
        message: 'Deploy current source',
        bundleBase64: 'bundle',
      }).success,
    ).toBe(false);
  });
});

describe('query app KV requests', () => {
  it('parses every action and defaults list pagination', () => {
    expect(queryAppKvRequestSchema.parse({ action: 'list' })).toEqual({
      action: 'list',
      limit: 100,
      revealSecrets: false,
    });
    expect(
      queryAppKvRequestSchema.parse({
        action: 'list',
        cursor: 'last-key',
        limit: 25,
      }),
    ).toEqual({
      action: 'list',
      cursor: 'last-key',
      limit: 25,
      revealSecrets: false,
    });
    expect(
      queryAppKvRequestSchema.parse({ action: 'get', key: 'token' }),
    ).toEqual({ action: 'get', key: 'token', revealSecrets: false });
    expect(
      queryAppKvRequestSchema.parse({
        action: 'set',
        key: 'token',
        value: 'value',
        secret: true,
      }),
    ).toEqual({
      action: 'set',
      key: 'token',
      value: 'value',
      secret: true,
    });
    expect(
      queryAppKvRequestSchema.safeParse({ action: 'delete', key: 'token' })
        .success,
    ).toBe(true);
  });

  it('allows explicit secret reveal only for read actions', () => {
    for (const input of [
      { action: 'list', revealSecrets: true },
      { action: 'get', key: 'token', revealSecrets: true },
    ]) {
      expect(queryAppKvRequestSchema.parse(input)).toMatchObject({
        revealSecrets: true,
      });
    }
    expect(
      queryAppKvRequestSchema.safeParse({
        action: 'set',
        key: 'token',
        value: 'value',
        revealSecrets: true,
      }).success,
    ).toBe(false);
    expect(
      queryAppKvRequestSchema.safeParse({
        action: 'delete',
        key: 'token',
        revealSecrets: true,
      }).success,
    ).toBe(false);
  });

  it('rejects missing, invalid, and action-inappropriate fields', () => {
    for (const input of [
      { action: 'get' },
      { action: 'set', key: 'token' },
      { action: 'delete', key: 'token', value: 'extra' },
      { action: 'list', key: 'extra' },
      { action: 'list', limit: 0 },
      { action: 'list', limit: 101 },
      { action: 'list', limit: 1.5 },
      { action: 'unknown' },
    ]) {
      expect(queryAppKvRequestSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('query app Data Table requests', () => {
  it('parses inspect and defaults structured query fields', () => {
    expect(queryAppDataTableRequestSchema.parse({ action: 'inspect' })).toEqual(
      { action: 'inspect' },
    );
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'inspect',
        table: 'todos',
      }),
    ).toEqual({ action: 'inspect', table: 'todos' });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'query',
        table: 'todos',
      }),
    ).toEqual({
      action: 'query',
      table: 'todos',
      where: [],
      limit: 50,
    });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'query',
        table: 'todos',
        where: [{ field: 'done', op: 'eq', value: false }],
        orderBy: { field: 'createdAt' },
        cursor: 'next-page',
        limit: 200,
      }),
    ).toEqual({
      action: 'query',
      table: 'todos',
      where: [{ field: 'done', op: 'eq', value: false }],
      orderBy: { field: 'createdAt', direction: 'asc' },
      cursor: 'next-page',
      limit: 200,
    });
  });

  it('parses every mutation and defaults patch unset', () => {
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'mutate',
        operations: [
          { type: 'insert', table: 'todos', value: { title: 'Ship' } },
          {
            type: 'patch',
            table: 'todos',
            id: 'todo-1',
            value: { done: true },
          },
          {
            type: 'increment',
            table: 'stats',
            id: 'stats-1',
            field: 'count',
            amount: 1,
          },
          { type: 'delete', table: 'todos', id: 'todo-2' },
        ],
      }),
    ).toEqual({
      action: 'mutate',
      operations: [
        { type: 'insert', table: 'todos', value: { title: 'Ship' } },
        {
          type: 'patch',
          table: 'todos',
          id: 'todo-1',
          value: { done: true },
          unset: [],
        },
        {
          type: 'increment',
          table: 'stats',
          id: 'stats-1',
          field: 'count',
          amount: 1,
        },
        { type: 'delete', table: 'todos', id: 'todo-2' },
      ],
    });
  });

  it('defaults and bounds raw SQL timeout without limiting statements', () => {
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'raw_sql',
        sql: 'select 1; select 2',
      }),
    ).toEqual({
      action: 'raw_sql',
      sql: 'select 1; select 2',
      timeoutMs: 30_000,
    });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'raw_sql',
        sql: 'select pg_sleep(1)',
        timeoutMs: 1_800_000,
      }),
    ).toMatchObject({ timeoutMs: 1_800_000 });
  });

  it('rejects invalid bounds and action-inappropriate or nested fields', () => {
    const tooManyFilters = Array.from({ length: 17 }, () => ({
      field: 'done',
      op: 'eq',
      value: false,
    }));
    for (const input of [
      { action: 'inspect', limit: 1 },
      { action: 'query' },
      { action: 'query', table: 'todos', limit: 0 },
      { action: 'query', table: 'todos', limit: 201 },
      { action: 'query', table: 'todos', where: tooManyFilters },
      {
        action: 'query',
        table: 'todos',
        cursor: 'x'.repeat(QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH + 1),
      },
      {
        action: 'query',
        table: 'todos',
        orderBy: { field: 'createdAt', extra: true },
      },
      { action: 'mutate', operations: [] },
      {
        action: 'mutate',
        operations: [
          { type: 'delete', table: 'todos', id: 'todo-1', extra: true },
        ],
      },
      { action: 'raw_sql', sql: '   ' },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 999 },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 1_800_001 },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 1_000.5 },
      { action: 'raw_sql', sql: 'select 1', table: 'todos' },
      { action: 'unknown' },
    ]) {
      expect(queryAppDataTableRequestSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });
});
