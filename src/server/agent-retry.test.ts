import { describe, expect, it } from 'vitest';
import type { JsonValue } from '~/db/schema';
import { parseRetryableAgentTurn } from './agent-retry';

describe('parseRetryableAgentTurn', () => {
  it('extracts the nearest user payload and truncates the failed turn', () => {
    const baseMessages: JsonValue[] = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier response' }],
        stopReason: 'stop',
      },
    ];
    const messages: JsonValue[] = [
      ...baseMessages,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Retry this' },
          { type: 'image', data: 'aW1hZ2Ux', mimeType: 'image/png' },
          { type: 'image', data: 'aW1hZ2Uy', mimeType: 'image/webp' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial response' }],
      },
      {
        role: 'toolResult',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'partial tool result' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];

    expect(parseRetryableAgentTurn(messages)).toEqual({
      baseMessages,
      userText: 'Retry this',
      images: [
        { data: 'aW1hZ2Ux', mimeType: 'image/png' },
        { data: 'aW1hZ2Uy', mimeType: 'image/webp' },
      ],
      attachments: [],
    });
  });

  it('supports legacy string-form user content', () => {
    expect(
      parseRetryableAgentTurn([
        { role: 'user', content: 'Retry this string' },
        { role: 'assistant', content: [], stopReason: 'error' },
      ]),
    ).toEqual({
      baseMessages: [],
      userText: 'Retry this string',
      images: [],
      attachments: [],
    });
  });

  it('recovers attachment refs while hiding their model-only prompt context', () => {
    expect(
      parseRetryableAgentTurn([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Inspect it\n\n<hatch_attachments>\n' +
                'These files are stored on the Platform and are not in the workspace yet.\n' +
                'Call download_attachment with an id when you need a local copy.\n' +
                '- id=file-a name="a.bin" type=application/octet-stream size=2\n' +
                '</hatch_attachments>',
            },
          ],
          attachments: [
            {
              id: 'file-a',
              name: 'a.bin',
              mimeType: 'application/octet-stream',
              size: 2,
            },
          ],
        },
        { role: 'assistant', content: [], stopReason: 'error' },
      ]),
    ).toEqual({
      baseMessages: [],
      userText: 'Inspect it',
      images: [],
      attachments: [
        {
          id: 'file-a',
          name: 'a.bin',
          mimeType: 'application/octet-stream',
          size: 2,
        },
      ],
    });
  });

  it('preserves a literal attachment tag when no metadata is present', () => {
    const literal =
      'Explain this XML:\n<hatch_attachments>literal</hatch_attachments>';
    expect(
      parseRetryableAgentTurn([
        { role: 'user', content: literal },
        { role: 'assistant', content: [], stopReason: 'error' },
      ]),
    ).toEqual({
      baseMessages: [],
      userText: literal,
      images: [],
      attachments: [],
    });
  });

  it('requires the provider error to be the literal last message', () => {
    const failed: JsonValue = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
    };
    const newerMessages: JsonValue[] = [
      { role: 'user', content: 'New request' },
      { role: 'toolResult', content: [], toolName: 'read_file' },
      { role: 'assistant', content: [], stopReason: 'stop' },
    ];

    for (const newer of newerMessages) {
      expect(
        parseRetryableAgentTurn([
          { role: 'user', content: 'Failed request' },
          failed,
          newer,
        ]),
      ).toBeNull();
    }
  });

  it('rejects aborted, successful, missing-user, and empty turns', () => {
    expect(
      parseRetryableAgentTurn([
        { role: 'user', content: 'Request' },
        { role: 'assistant', content: [], stopReason: 'aborted' },
      ]),
    ).toBeNull();
    expect(
      parseRetryableAgentTurn([
        { role: 'user', content: 'Request' },
        { role: 'assistant', content: [], stopReason: 'stop' },
      ]),
    ).toBeNull();
    expect(
      parseRetryableAgentTurn([
        { role: 'assistant', content: [], stopReason: 'error' },
      ]),
    ).toBeNull();
    expect(
      parseRetryableAgentTurn([
        { role: 'user', content: [{ type: 'text', text: '   ' }] },
        { role: 'assistant', content: [], stopReason: 'error' },
      ]),
    ).toBeNull();
  });
});
