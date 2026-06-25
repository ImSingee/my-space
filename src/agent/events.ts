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
