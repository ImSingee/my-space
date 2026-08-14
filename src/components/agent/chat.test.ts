import { describe, expect, it } from 'vitest';
import {
  getRetryableErrorInput,
  groupTurns,
  hasPersistedAgentError,
  splitAssistantTurn,
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
    ).toBe('latest advances in battery chemistry');
    expect(
      toolDetail('web_fetch', {
        url: 'https://example.com/research/paper',
        query: 'ignored for the compact summary',
      }),
    ).toBe('https://example.com/research/paper');
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

  it('keeps existing command and edit inputs as single sections', () => {
    expect(toolInputDetails('run_command', { command: 'pnpm test' })).toEqual([
      { label: 'Command', value: 'pnpm test' },
    ]);
    expect(toolInputDetails('edit_file', { path: 'src/app.ts' })).toEqual([
      { label: 'File path', value: 'src/app.ts' },
    ]);
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
        lastMessageStart: 1,
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
      lastMessageStart: 0,
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    });
  });

  it('preserves the latest assistant message boundary across tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Build it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the project.' },
          {
            type: 'toolCall',
            id: 'read-project',
            name: 'read_file',
            arguments: { path: 'src/app.ts' },
          },
        ],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'const app = true;' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Checking the result.' },
          { type: 'text', text: 'The app is ready.' },
        ],
        stopReason: 'stop',
      },
    ];

    expect(groupTurns(messages)[1]).toMatchObject({
      kind: 'assistant',
      lastMessageStart: 2,
      stopReason: 'stop',
      blocks: [
        { type: 'text', text: 'I will inspect the project.' },
        { type: 'toolCall', id: 'read-project' },
        { type: 'thinking', thinking: 'Checking the result.' },
        { type: 'text', text: 'The app is ready.' },
      ],
    });
  });
});

describe('splitAssistantTurn', () => {
  const intermediate: AssistantBlock = {
    type: 'text',
    text: 'I will inspect the project.',
  };
  const tool: AssistantBlock = {
    type: 'toolCall',
    id: 'read-project',
    name: 'read_file',
    arguments: { path: 'src/app.ts' },
  };
  const finalThinking: AssistantBlock = {
    type: 'thinking',
    thinking: 'Checking the result.',
  };
  const finalText: AssistantBlock = {
    type: 'text',
    text: 'The app is ready.',
  };

  it('keeps earlier prose and final reasoning in work while exposing the trailing answer', () => {
    const blocks = [intermediate, tool, finalThinking, finalText];

    expect(splitAssistantTurn(blocks, 2, 'stop')).toEqual({
      work: [intermediate, tool, finalThinking],
      final: [finalText],
    });
  });

  it('renders a pure terminal answer without work', () => {
    expect(splitAssistantTurn([finalText], 0, 'stop')).toEqual({
      work: [],
      final: [finalText],
    });
  });

  it.each(['error', 'aborted', 'toolUse'] as const)(
    'keeps every partial block in work for %s',
    (stopReason) => {
      const blocks = [intermediate, tool, finalText];
      expect(splitAssistantTurn(blocks, 2, stopReason)).toEqual({
        work: blocks,
        final: [],
      });
    },
  );

  it('uses the latest message boundary for legacy transcripts', () => {
    const blocks = [intermediate, finalText];
    expect(splitAssistantTurn(blocks, 1)).toEqual({
      work: [intermediate],
      final: [finalText],
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
