import { describe, expect, it } from 'vitest';
import { nextUserTurn } from '~agent/user-turns';
import { getRetryableErrorInput, groupTurns } from './chat-turns';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  successfullyDeployedAppIds,
} from './types';

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
      { kind: 'user', key: 'm0', userTurn: 0, message: messages[0] },
      {
        kind: 'assistant',
        key: 'm1',
        userTurn: 0,
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

  it('binds each reply to the user turn its run recorded', () => {
    // Matches the platform's count: the n-th `role: 'user'` message is user
    // turn n, including a prompt whose run never produced a reply.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Dispatch failed for this one' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'list_apps', arguments: {} },
        ],
      },
      { role: 'toolResult', toolName: 'list_apps', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'Third' },
    ];

    expect(
      groupTurns(messages).map((turn) => [turn.kind, turn.userTurn]),
    ).toEqual([
      ['user', 0],
      ['user', 1],
      ['assistant', 1],
      ['user', 2],
    ]);
    expect(nextUserTurn(messages)).toBe(3);
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
