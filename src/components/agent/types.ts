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
      /** Structured result data persisted by pi tools. */
      details?: unknown;
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
  query_app_data_table: 'Query app Data Table',
  query_app_kv: 'Query app KV',
  list_workflows: 'List workflows',
  get_workflow: 'Get workflow',
  checkout_workflow: 'Checkout workflow',
  create_workflow: 'Create workflow',
  deploy_workflow: 'Deploy workflow',
  rollback_workflow: 'Rollback workflow',
  web_search: 'Web search',
  web_fetch: 'Fetch web page',
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
      : name === 'web_search'
        ? pick('query')
        : name === 'web_fetch'
          ? pick('url')
          : (pick('id') ?? pick('path') ?? pick('name'));
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}

export type ToolInputDetail = {
  label: string;
  value: string;
  emptyText?: string;
};

function appendSerializableInput(
  details: ToolInputDetail[],
  label: string,
  value: unknown,
): void {
  if (typeof value === 'string') {
    details.push({ label, value });
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    details.push({ label, value: String(value) });
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    details.push({ label, value: JSON.stringify(value) });
  }
}

/** Complete inputs that need an inspectable form beyond the compact summary. */
export function toolInputDetails(
  name: string,
  args: Record<string, unknown> | undefined,
): ToolInputDetail[] | undefined {
  if (!args) return undefined;
  if (name === 'run_command' && typeof args.command === 'string') {
    return [{ label: 'Command', value: args.command }];
  }
  if (
    (name === 'read_file' || name === 'edit_file') &&
    typeof args.path === 'string'
  ) {
    return [{ label: 'File path', value: args.path }];
  }
  if (name === 'web_search') {
    const details: ToolInputDetail[] = [];
    appendSerializableInput(details, 'Query', args.query);
    appendSerializableInput(details, 'Maximum results', args.max_results);
    appendSerializableInput(details, 'Search depth', args.search_depth);
    appendSerializableInput(details, 'Topic', args.topic);
    appendSerializableInput(details, 'Time range', args.time_range);
    appendSerializableInput(details, 'Include domains', args.include_domains);
    appendSerializableInput(details, 'Exclude domains', args.exclude_domains);
    return details.length > 0 ? details : undefined;
  }
  if (name === 'web_fetch') {
    const details: ToolInputDetail[] = [];
    appendSerializableInput(details, 'URL', args.url);
    appendSerializableInput(details, 'Query', args.query);
    appendSerializableInput(details, 'Extract depth', args.extract_depth);
    return details.length > 0 ? details : undefined;
  }
  if (name === 'write_file') {
    const details: ToolInputDetail[] = [];
    if (typeof args.path === 'string') {
      details.push({ label: 'File path', value: args.path });
    }
    if (typeof args.content === 'string') {
      details.push({
        label: 'File contents',
        value: args.content,
        emptyText: '(empty file)',
      });
    }
    return details.length > 0 ? details : undefined;
  }
  return undefined;
}

/**
 * App ids that an assistant turn successfully deployed, in call order.
 *
 * A tool call alone only means the Agent attempted a deploy. Requiring its
 * paired, non-error result keeps failed or incomplete calls from producing a
 * misleading app action in the finished transcript.
 */
export function successfullyDeployedAppIds(
  blocks: AssistantBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage> | undefined,
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'toolCall' && block.name === 'deploy_app') {
      const result = toolResults?.get(block.id);
      if (!result || result.isError) continue;
      const id = block.arguments?.id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids];
}
