import { describe, expect, it } from 'vitest';
import { groupTurns, hasPersistedAgentError } from './chat-turns';
import type { ChatMessage } from './types';

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
