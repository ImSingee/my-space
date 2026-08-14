import type { StopReason } from '@earendil-works/pi-ai';
import { type AssistantBlock, type ChatMessage, partsToText } from './types';

export type RenderTurn =
  | { kind: 'user'; key: string; message: ChatMessage }
  | {
      kind: 'assistant';
      key: string;
      blocks: AssistantBlock[];
      /** Block offset where the latest persisted assistant message begins. */
      lastMessageStart: number;
      stopReason?: StopReason;
      errorMessage?: string;
    };

export type AssistantTurnParts = {
  work: AssistantBlock[];
  final: AssistantBlock[];
};

/**
 * Split a finished assistant turn into collapsible work and its visible answer.
 *
 * Persisted tool loops contain several assistant messages. Message boundaries
 * keep prose from earlier tool-use messages in the work history, while the last
 * technical block inside the terminal message separates its reasoning from the
 * trailing answer text.
 */
export function splitAssistantTurn(
  blocks: AssistantBlock[],
  lastMessageStart: number,
  stopReason?: StopReason,
): AssistantTurnParts {
  if (
    stopReason === 'error' ||
    stopReason === 'aborted' ||
    stopReason === 'toolUse'
  ) {
    return { work: blocks, final: [] };
  }

  const safeLastMessageStart = Math.min(
    Math.max(lastMessageStart, 0),
    blocks.length,
  );
  let finalStart = safeLastMessageStart;
  for (let index = blocks.length - 1; index >= safeLastMessageStart; index--) {
    if (blocks[index].type !== 'text') {
      finalStart = index + 1;
      break;
    }
  }

  return {
    work: blocks.slice(0, finalStart),
    final: blocks.slice(finalStart),
  };
}

/**
 * Collapse one agent reply — which the backend may split across several
 * assistant + tool-result messages — into a single turn. Tool-result messages
 * are dropped because they are merged into their call rows by `pairToolResults`.
 */
export function groupTurns(messages: ChatMessage[]): RenderTurn[] {
  const turns: RenderTurn[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({ kind: 'user', key: `m${index}`, message });
    } else if (message.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.kind === 'assistant') {
        last.lastMessageStart = last.blocks.length;
        last.blocks = [...last.blocks, ...message.content];
        last.stopReason = message.stopReason ?? last.stopReason;
        last.errorMessage = message.errorMessage ?? last.errorMessage;
      } else {
        turns.push({
          kind: 'assistant',
          key: `m${index}`,
          blocks: [...message.content],
          lastMessageStart: 0,
          ...(message.stopReason ? { stopReason: message.stopReason } : {}),
          ...(message.errorMessage
            ? { errorMessage: message.errorMessage }
            : {}),
        });
      }
    }
  });
  return turns;
}

/** Whether the canonical transcript can replace a just-finished live error. */
export function hasPersistedAgentError(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === 'assistant' && last.stopReason === 'error';
}

/**
 * Recover the latest failed turn's original user payload for a retry.
 *
 * Only a provider error at the literal end of the raw transcript is retryable:
 * once anything newer exists, replaying the older prompt could duplicate work.
 */
export function getRetryableErrorInput(messages: ChatMessage[]): {
  text: string;
  images: { data: string; mimeType: string }[];
  userMessageIndex: number;
} | null {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return null;

  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;

    const text = partsToText(message.content, message.attachments);
    const images =
      typeof message.content === 'string'
        ? []
        : message.content.flatMap((part) =>
            part.type === 'image' &&
            typeof part.data === 'string' &&
            part.data.length > 0 &&
            typeof part.mimeType === 'string' &&
            part.mimeType.length > 0
              ? [{ data: part.data, mimeType: part.mimeType }]
              : [],
          );

    return text.trim().length > 0 ||
      images.length > 0 ||
      (message.attachments?.length ?? 0) > 0
      ? { text, images, userMessageIndex: index }
      : null;
  }

  return null;
}
