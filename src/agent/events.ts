/** Stream event protocol between the Agent SSE endpoint and the chat UI. */
import type { JsonValue } from '~/db/schema';

export type AgentStreamEvent =
  | { type: 'assistant_start' }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      label?: string;
      args: JsonValue;
    }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      summary?: string;
    }
  | { type: 'turn_end' }
  | { type: 'done'; messages: JsonValue[]; title: string }
  | { type: 'error'; message: string };
