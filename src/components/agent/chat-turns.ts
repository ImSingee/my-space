import type { StopReason } from '@earendil-works/pi-ai';
import type { AssistantBlock, ChatMessage } from './types';

export type RenderTurn =
  | { kind: 'user'; key: string; message: ChatMessage }
  | {
      kind: 'assistant';
      key: string;
      blocks: AssistantBlock[];
      stopReason?: StopReason;
      errorMessage?: string;
    };

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
        last.blocks = [...last.blocks, ...message.content];
        last.stopReason = message.stopReason ?? last.stopReason;
        last.errorMessage = message.errorMessage ?? last.errorMessage;
      } else {
        turns.push({
          kind: 'assistant',
          key: `m${index}`,
          blocks: [...message.content],
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
