import type { StopReason } from '@earendil-works/pi-ai';
import type { AgentRunStatus } from '~/db/schema';
import type { SessionRunTiming } from '~server/agent-runs';
import { type AssistantBlock, type ChatMessage, partsToText } from './types';
import type { WorkPhase } from './work-process';

export type RenderTurn =
  | { kind: 'user'; key: string; userTurn: number; message: ChatMessage }
  | {
      kind: 'assistant';
      key: string;
      /**
       * The user turn this reply answers (see `~agent/user-turns`), which
       * binds it to its run; null for a reply before any user message.
       */
      userTurn: number | null;
      blocks: AssistantBlock[];
      stopReason?: StopReason;
      errorMessage?: string;
    };

/**
 * Collapse one agent reply — which the backend may split across several
 * assistant + tool-result messages — into a single turn. Tool-result messages
 * are dropped because they are merged into their call rows by `pairToolResults`.
 * Blocks keep their order, so the reply's last text stays its final answer.
 */
export function groupTurns(messages: ChatMessage[]): RenderTurn[] {
  const turns: RenderTurn[] = [];
  let userTurns = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({
        kind: 'user',
        key: `m${index}`,
        userTurn: userTurns,
        message,
      });
      userTurns += 1;
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
          userTurn: userTurns > 0 ? userTurns - 1 : null,
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

/**
 * Index of a reply's final answer: its last non-empty text block. Everything
 * before it is the work process; -1 means the reply has no answer text.
 */
export function finalTextIndex<Block>(
  blocks: readonly Block[],
  textOf: (block: Block) => string | undefined,
): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (textOf(blocks[index])?.trim()) return index;
  }
  return -1;
}

export function isActiveRunStatus(status: AgentRunStatus): boolean {
  return status === 'running' || status === 'blocked';
}

/**
 * How a persisted reply ended. The transcript's own stop reason wins; the run
 * status covers ends the transcript cannot express (interrupted, stopped
 * before any output). Unbound legacy replies read as finished.
 */
export function persistedWorkPhase(
  run: SessionRunTiming | undefined,
  stopReason: StopReason | undefined,
): WorkPhase {
  if (run && isActiveRunStatus(run.status)) return 'running';
  if (stopReason === 'error') return 'failed';
  if (stopReason === 'aborted') return 'cancelled';
  if (run?.status === 'cancelled') return 'cancelled';
  if (run?.status === 'failed' || run?.status === 'interrupted') {
    return 'failed';
  }
  return 'completed';
}

/**
 * The assistant message to render for a run's reply. A failed or interrupted
 * run whose transcript does not record the failure (or holds no reply at all)
 * shows the run's own error, so the notice survives without a toast.
 */
export function replyMessage(
  blocks: AssistantBlock[],
  stopReason: StopReason | undefined,
  errorMessage: string | undefined,
  run: SessionRunTiming | undefined,
): Extract<ChatMessage, { role: 'assistant' }> {
  const runFailed = run?.status === 'failed' || run?.status === 'interrupted';
  if (runFailed && stopReason !== 'error') {
    return {
      role: 'assistant',
      content: blocks,
      stopReason: 'error',
      ...(run.error ? { errorMessage: run.error } : {}),
    };
  }
  return {
    role: 'assistant',
    content: blocks,
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
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

    const text = partsToText(
      message.content,
      message.attachments,
      message.composerContent,
    );
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
