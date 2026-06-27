/** Loose, render-friendly shapes for persisted pi `AgentMessage`s. */

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
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: AssistantBlock[] }
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

export function partsToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/** Image attachments in a message, as ready-to-use data URLs. */
export function partsToImages(content: string | ContentPart[]): string[] {
  if (typeof content === 'string') return [];
  return content
    .filter((p) => p.type === 'image' && typeof p.data === 'string')
    .map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`);
}

/** Human-readable labels for tools the Agent can call. */
export const TOOL_LABELS: Record<string, string> = {
  list_files: 'List files',
  read_file: 'Read file',
  edit_file: 'Edit file',
  write_file: 'Write file',
  run_command: 'Run command',
  checkout_app: 'Checkout app',
  create_app: 'Create app',
  deploy_app: 'Deploy app',
  rollback_app: 'Rollback app',
  query_app_db: 'Query DB',
  ask: 'Ask the user',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
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
