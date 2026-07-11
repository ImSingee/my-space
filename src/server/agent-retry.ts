import type { JsonValue } from '~/db/schema';
import type { SendImage } from '~agent/protocol';

export type RetryableAgentTurn = {
  /** Transcript before the user message that started the failed turn. */
  baseMessages: JsonValue[];
  userText: string;
  images: SendImage[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Recover a retry from the canonical persisted transcript.
 *
 * The literal last message must be an assistant provider error. Anything newer
 * makes the failed turn stale and therefore unsafe to replay. The returned base
 * excludes the failed turn's user message and every later partial/tool message.
 */
export function parseRetryableAgentTurn(
  messages: JsonValue[],
): RetryableAgentTurn | null {
  const last = asObject(messages.at(-1));
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return null;

  for (let index = messages.length - 2; index >= 0; index--) {
    const message = asObject(messages[index]);
    if (message?.role !== 'user') continue;

    const textParts: string[] = [];
    const images: SendImage[] = [];
    if (typeof message.content === 'string') {
      textParts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = asObject(rawPart);
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (
          part.type === 'image' &&
          typeof part.data === 'string' &&
          part.data.length > 0 &&
          typeof part.mimeType === 'string' &&
          part.mimeType.length > 0
        ) {
          images.push({ data: part.data, mimeType: part.mimeType });
        }
      }
    }

    const userText = textParts.join('');
    if (userText.trim().length === 0 && images.length === 0) return null;
    return {
      baseMessages: messages.slice(0, index),
      userText,
      images,
    };
  }

  return null;
}
