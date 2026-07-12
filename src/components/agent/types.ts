/** Loose, render-friendly shapes for persisted pi `AgentMessage`s. */

import type { StopReason } from '@earendil-works/pi-ai';
import type { AgentAttachmentRef } from '~agent/attachments';
import { stripAttachmentPrompt } from '~agent/attachments';

export type TextBlock = { type: 'text'; text: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ToolCallBlock = {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export type ContentPart = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

export type ChatMessage =
  | {
      role: 'user';
      content: string | ContentPart[];
      attachments?: AgentAttachmentRef[];
    }
  | {
      role: 'assistant';
      content: AssistantBlock[];
      /** Persisted pi terminal state; optional for legacy/synthetic messages. */
      stopReason?: StopReason;
      /** Provider/runtime detail when `stopReason` is `error`. */
      errorMessage?: string;
    }
  | {
      role: 'toolResult';
      toolName: string;
      content: ContentPart[];
      isError?: boolean;
    };

export type ToolResultMessage = Extract<ChatMessage, { role: 'toolResult' }>;

/**
 * Map each tool-call id to its result message so a call and its output can be
 * rendered as a single collapsible step. Results arrive sequentially after
 * their calls, so we match the oldest pending call of the same tool name.
 */
export function pairToolResults(
  messages: ChatMessage[],
): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  const pending: { id: string; name: string }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          pending.push({ id: block.id, name: block.name });
        }
      }
    } else if (message.role === 'toolResult') {
      let index = pending.findIndex((p) => p.name === message.toolName);
      if (index < 0 && pending.length > 0) index = 0;
      if (index >= 0) {
        const [hit] = pending.splice(index, 1);
        map.set(hit.id, message);
      }
    }
  }
  return map;
}

export function partsToText(
  content: string | ContentPart[],
  attachments: AgentAttachmentRef[] = [],
): string {
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('');
  return stripAttachmentPrompt(text, attachments);
}

/** Image attachments in a message, as ready-to-use data URLs. */
export function partsToImages(content: string | ContentPart[]): string[] {
  if (typeof content === 'string') return [];
  return content
    .filter((p) => p.type === 'image' && typeof p.data === 'string')
    .map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`);
}

/**
 * Fallback labels for persisted tool calls (historical messages carry no
 * label). Live runs send the authoritative label on the `tool_start` event, so
 * this map only needs to cover tools that may appear in saved transcripts; keep
 * it in rough sync with the server tool definitions.
 */
export const TOOL_LABELS: Record<string, string> = {
  list_files: 'List files',
  read_file: 'Read file',
  edit_file: 'Edit file',
  write_file: 'Write file',
  run_command: 'Run command',
  download_attachment: 'Download attachment',
  list_apps: 'List apps',
  get_app: 'Get app',
  checkout_app: 'Checkout app',
  create_app: 'Create app',
  deploy_app: 'Deploy app',
  rollback_app: 'Rollback app',
  query_app_db: 'Query app DB',
  list_workflows: 'List workflows',
  get_workflow: 'Get workflow',
  checkout_workflow: 'Checkout workflow',
  create_workflow: 'Create workflow',
  deploy_workflow: 'Deploy workflow',
  rollback_workflow: 'Rollback workflow',
  ask: 'Ask the user',
};

/**
 * Prefer the label the server sent with the event; fall back to the static map
 * for persisted calls, then to the raw tool name.
 */
export function toolLabel(name: string, label?: string): string {
  return label ?? TOOL_LABELS[name] ?? name;
}

/** A short argument hint shown next to a tool chip, e.g. the path or id. */
export function toolDetail(
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const pick = (key: string) => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };
  const raw =
    name === 'run_command'
      ? pick('command')
      : (pick('id') ?? pick('path') ?? pick('name'));
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

/**
 * App ids that an assistant message *deployed*, so we can offer "Open app"
 * links. Limited to deploy_app because that is when the app is actually live
 * (a freshly created-but-not-deployed app has nothing to open yet).
 */
export function deployedAppIds(blocks: AssistantBlock[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'toolCall' && block.name === 'deploy_app') {
      const id = block.arguments?.id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids];
}
