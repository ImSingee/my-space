/** Stream event protocol between the Agent SSE endpoint and the chat UI. */
import type { JsonValue } from '~/db/schema';

/** A selectable option for an Agent `ask` question. */
export type AskOption = { id: string; label: string };

/** A single question the Agent poses to the user via the `ask` tool. */
export type AskQuestion = {
  id: string;
  prompt: string;
  options: AskOption[];
  /** When true the user may pick multiple options. */
  allowMultiple: boolean;
};

/** The user's reply to one `AskQuestion`. */
export type AskAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  /** Free-text entered via the "Other" option, if any. */
  customText?: string;
};

export type AgentStreamEvent =
  | { type: 'assistant_start' }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'ask'; askId: string; questions: AskQuestion[] }
  | { type: 'ask_answered'; askId: string }
  | {
      type: 'tool_start';
      id: string;
      name: string;
      label?: string;
      args: JsonValue;
    }
  | {
      /** Incremental output for a still-running tool (e.g. live shell stdout). */
      type: 'tool_update';
      id: string;
      name: string;
      output: string;
    }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      /** Final tool output text, streamed as soon as the tool finishes. */
      output?: string;
      summary?: string;
    }
  | { type: 'turn_end' }
  | { type: 'cancelled' }
  | { type: 'done'; messages: JsonValue[]; title: string }
  | { type: 'error'; message: string };

export type AgentRunStreamEvent = {
  seq: number;
  event: AgentStreamEvent;
};
