import { describe, expect, it } from 'vitest';
import {
  getRetryableErrorInput,
  groupTurns,
  hasPersistedAgentError,
} from './chat-turns';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  successfullyDeployedAppIds,
  toolDetail,
  toolInputDetails,
  toolLabel,
} from './types';

describe('web tool presentation', () => {
  it('uses friendly fallback labels', () => {
    expect(toolLabel('web_search')).toBe('Web search');
    expect(toolLabel('web_fetch')).toBe('Fetch web page');
  });

  it('summarizes searches by query and fetches by URL', () => {
    expect(
      toolDetail('web_search', {
        query: 'latest advances in battery chemistry',
      }),
    ).toEqual({
      value: 'latest advances in battery chemistry',
      ellipsis: 'end',
    });
    expect(
      toolDetail('web_fetch', {
        url: 'https://example.com/research/paper',
        query: 'ignored for the compact summary',
      }),
    ).toEqual({
      value: 'https://example.com/research/paper',
      ellipsis: 'end',
    });
  });
});

describe('tool header details', () => {
  it('keeps complete paths and marks them for leading ellipsis', () => {
    const path =
      '/Users/wangxuan/Documents/PProjects/my-space/skills/building-apps/SKILL.md';

    expect(toolDetail('read_file', { path })).toEqual({
      value: path,
      ellipsis: 'start',
    });
    expect(toolDetail('write_file', { path, content: 'contents' })).toEqual({
      value: path,
      ellipsis: 'start',
    });
  });

  it('normalizes list roots without inventing a path for invalid input', () => {
    expect(toolDetail('list_files', {})).toEqual({
      value: '.',
      ellipsis: 'start',
    });
    expect(toolDetail('list_files', { path: '' })).toEqual({
      value: '.',
      ellipsis: 'start',
    });
    expect(toolDetail('list_files', { path: null })).toBeUndefined();
    expect(toolDetail('list_files', null)).toBeUndefined();
    expect(toolDetail('list_files', [])).toBeUndefined();
  });

  it('keeps non-path details compact and preserves their beginning', () => {
    const command = `pnpm exec ${'command-part-'.repeat(8)}`;

    expect(toolDetail('run_command', { command })).toEqual({
      value: `${command.slice(0, 48)}…`,
      ellipsis: 'end',
    });
    expect(
      toolDetail('custom_tool', {
        id: 'app-id',
        path: '/ignored/path/to/app-id',
      }),
    ).toEqual({ value: 'app-id', ellipsis: 'end' });
  });
});

describe('toolInputDetails', () => {
  it('returns ordered write inputs and preserves an empty file', () => {
    expect(
      toolInputDetails('write_file', {
        path: 'src/app.ts',
        content: '',
      }),
    ).toEqual([
      { label: 'File path', value: 'src/app.ts' },
      {
        label: 'File contents',
        value: '',
        emptyText: '(empty file)',
      },
    ]);
  });

  it('keeps command, read, and edit inputs as single sections', () => {
    expect(toolInputDetails('run_command', { command: 'pnpm test' })).toEqual([
      { label: 'Command', value: 'pnpm test' },
    ]);
    expect(
      toolInputDetails('read_file', {
        path: 'src/app.ts',
        offset: 20,
        limit: 100,
      }),
    ).toEqual([{ label: 'File path', value: 'src/app.ts' }]);
    expect(toolInputDetails('edit_file', { path: 'src/app.ts' })).toEqual([
      { label: 'File path', value: 'src/app.ts' },
    ]);
  });

  it('normalizes valid listed directory paths without masking invalid ones', () => {
    expect(toolInputDetails('list_files', {})).toEqual([
      { label: 'File path', value: '.' },
    ]);
    expect(toolInputDetails('list_files', { path: '' })).toEqual([
      { label: 'File path', value: '.' },
    ]);
    expect(toolInputDetails('list_files', { path: 'src/components' })).toEqual([
      { label: 'File path', value: 'src/components' },
    ]);
    expect(toolInputDetails('list_files', { path: null })).toBeUndefined();
    expect(toolInputDetails('list_files', null)).toBeUndefined();
    expect(toolInputDetails('list_files', [])).toBeUndefined();
  });

  it('omits a read file path when it is missing or invalid', () => {
    expect(toolInputDetails('read_file', {})).toBeUndefined();
    expect(toolInputDetails('read_file', { path: 42 })).toBeUndefined();
  });

  it('exposes complete web search and fetch inputs', () => {
    const query = 'site:example.com a deliberately detailed search query';
    const url = 'https://example.com/a/complete/article/url';

    expect(
      toolInputDetails('web_search', {
        query,
        max_results: 10,
        search_depth: 'advanced',
        topic: 'news',
        time_range: 'week',
        include_domains: ['example.com', 'docs.example.com'],
        exclude_domains: ['spam.example.com'],
      }),
    ).toEqual([
      { label: 'Query', value: query },
      { label: 'Maximum results', value: '10' },
      { label: 'Search depth', value: 'advanced' },
      { label: 'Topic', value: 'news' },
      { label: 'Time range', value: 'week' },
      {
        label: 'Include domains',
        value: '["example.com","docs.example.com"]',
      },
      { label: 'Exclude domains', value: '["spam.example.com"]' },
    ]);
    expect(
      toolInputDetails('web_fetch', {
        url,
        query,
        extract_depth: 'advanced',
      }),
    ).toEqual([
      { label: 'URL', value: url },
      { label: 'Query', value: query },
      { label: 'Extract depth', value: 'advanced' },
    ]);
  });

  it('omits absent web options and preserves explicitly empty domain lists', () => {
    expect(toolInputDetails('web_search', { query: 'required only' })).toEqual([
      { label: 'Query', value: 'required only' },
    ]);
    expect(
      toolInputDetails('web_search', {
        query: 'empty filters',
        include_domains: [],
        exclude_domains: [],
      }),
    ).toEqual([
      { label: 'Query', value: 'empty filters' },
      { label: 'Include domains', value: '[]' },
      { label: 'Exclude domains', value: '[]' },
    ]);
    expect(
      toolInputDetails('web_fetch', { url: 'https://example.com' }),
    ).toEqual([{ label: 'URL', value: 'https://example.com' }]);
  });
});

describe('successfullyDeployedAppIds', () => {
  it('keeps successful deploys in call order and drops failed or incomplete calls', () => {
    const blocks: AssistantBlock[] = [
      {
        type: 'toolCall',
        id: 'deploy-a',
        name: 'deploy_app',
        arguments: { id: 'alpha' },
      },
      {
        type: 'toolCall',
        id: 'deploy-b',
        name: 'deploy_app',
        arguments: { id: 'beta' },
      },
      {
        type: 'toolCall',
        id: 'deploy-c',
        name: 'deploy_app',
        arguments: { id: 'gamma' },
      },
      {
        type: 'toolCall',
        id: 'deploy-a-again',
        name: 'deploy_app',
        arguments: { id: 'alpha' },
      },
    ];
    const result = (isError = false): ToolResultMessage => ({
      role: 'toolResult',
      toolName: 'deploy_app',
      content: [{ type: 'text', text: 'result' }],
      isError,
    });
    const toolResults = new Map([
      ['deploy-a', result()],
      ['deploy-b', result(true)],
      ['deploy-a-again', result()],
    ]);

    expect(successfullyDeployedAppIds(blocks, toolResults)).toEqual(['alpha']);
  });
});

describe('groupTurns', () => {
  it('keeps a terminal assistant error when it follows partial output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Build it' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I started the work.' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      },
    ];

    expect(groupTurns(messages)).toEqual([
      { kind: 'user', key: 'm0', message: messages[0] },
      {
        kind: 'assistant',
        key: 'm1',
        blocks: [{ type: 'text', text: 'I started the work.' }],
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      },
    ]);
  });

  it('keeps an empty error reply as a visible assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];

    expect(groupTurns(messages)[1]).toMatchObject({
      kind: 'assistant',
      blocks: [],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    });
  });
});

describe('hasPersistedAgentError', () => {
  it('only accepts a terminal provider error at the end of the transcript', () => {
    expect(
      hasPersistedAgentError([
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Provider unavailable',
        },
      ]),
    ).toBe(true);

    expect(
      hasPersistedAgentError([
        {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
        },
      ]),
    ).toBe(false);
    expect(hasPersistedAgentError([{ role: 'user', content: 'Retry' }])).toBe(
      false,
    );
  });
});

describe('getRetryableErrorInput', () => {
  it('restores text and base64 images from the nearest user message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Older request' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Build from these images' },
          {
            type: 'image',
            data: 'aW1hZ2UtMQ==',
            mimeType: 'image/png',
          },
          {
            type: 'image',
            data: 'aW1hZ2UtMg==',
            mimeType: 'image/webp',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial reply' }],
      },
      {
        role: 'toolResult',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'result' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];

    expect(getRetryableErrorInput(messages)).toEqual({
      text: 'Build from these images',
      userMessageIndex: 2,
      images: [
        { data: 'aW1hZ2UtMQ==', mimeType: 'image/png' },
        { data: 'aW1hZ2UtMg==', mimeType: 'image/webp' },
      ],
    });
  });

  it('restores a string-form user message', () => {
    expect(
      getRetryableErrorInput([
        { role: 'user', content: 'Try this again' },
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Provider unavailable',
        },
      ]),
    ).toEqual({ text: 'Try this again', images: [], userMessageIndex: 0 });
  });

  it('returns null when any message follows the failed assistant', () => {
    const user: ChatMessage = { role: 'user', content: 'Original request' };
    const failed: ChatMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    };
    const newerMessages: ChatMessage[] = [
      { role: 'user', content: 'A newer request' },
      {
        role: 'toolResult',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'late result' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] },
    ];

    for (const newer of newerMessages) {
      expect(getRetryableErrorInput([user, failed, newer])).toBeNull();
    }
  });

  it('rejects aborted and successful terminal assistants', () => {
    const user: ChatMessage = { role: 'user', content: 'Original request' };

    expect(
      getRetryableErrorInput([
        user,
        {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
        },
      ]),
    ).toBeNull();
    expect(
      getRetryableErrorInput([
        user,
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'stop',
        },
      ]),
    ).toBeNull();
  });

  it('returns null without a usable user payload', () => {
    const failed: ChatMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    };

    expect(getRetryableErrorInput([failed])).toBeNull();
    expect(
      getRetryableErrorInput([
        {
          role: 'user',
          content: [
            { type: 'text', text: '   ' },
            { type: 'image', data: 'missing-mime-type' },
          ],
        },
        failed,
      ]),
    ).toBeNull();
  });
});
