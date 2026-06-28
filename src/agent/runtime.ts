/** Server-only: run one Agent turn for a session and stream events out. */
import { mkdirSync } from 'node:fs';
import {
  AgentHarness,
  InMemorySessionRepo,
  loadSkills,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { Models } from '@earendil-works/pi-ai';
import type { JsonValue } from '~/db/schema';
import type { ResolvedModel } from './build-models';
import type { AgentStreamEvent } from './events';
import { agentWorkDir, SKILLS_DIR } from './paths';
import { agentShellEnv } from './shell-env';
import { buildSystemPrompt } from './system-prompt';
import { createTools, type AskBridge } from './tools';

/** Keep streamed tool output small; the full result is persisted on `done`. */
const MAX_STREAM_OUTPUT = 4000;

function clip(text: string): string {
  return text.length > MAX_STREAM_OUTPUT
    ? `${text.slice(0, MAX_STREAM_OUTPUT)}\n… (truncated)`
    : text;
}

/** Extract readable text from a tool result or a tool's partial update. */
function extractToolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

export type RunAgentTurnOptions = {
  priorMessages: AgentMessage[];
  sessionId: string;
  userText: string;
  images?: { data: string; mimeType: string }[];
  models: Models;
  picked: ResolvedModel;
  signal: AbortSignal;
  ask?: AskBridge;
  emit: (event: AgentStreamEvent) => void;
};

export type RunAgentTurnResult = {
  messages: JsonValue[];
  error?: string;
};

export async function runAgentTurn(
  opts: RunAgentTurnOptions,
): Promise<RunAgentTurnResult> {
  const { priorMessages, sessionId, userText, signal, emit, models, picked } =
    opts;

  const cwd = agentWorkDir(sessionId);
  mkdirSync(cwd, { recursive: true });

  // Never hand the model's shell the raw server env: with run_command it could
  // otherwise read host secrets (DATABASE_URL, auth keys, provider keys, …),
  // including via prompt-injected project files. agentShellEnv() strips
  // everything outside a small dev allowlist.
  const env = new NodeExecutionEnv({
    cwd,
    shellEnv: agentShellEnv(),
  });

  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: sessionId });
  for (const message of priorMessages) {
    await session.appendMessage(message);
  }

  const { skills } = await loadSkills(env, SKILLS_DIR);
  const tools = createTools(env, {
    ...(opts.ask ? { ask: opts.ask } : {}),
    sessionId,
  });

  const harness = new AgentHarness({
    env,
    session,
    models,
    model: picked.model,
    tools,
    resources: { skills },
    systemPrompt: buildSystemPrompt(),
    thinkingLevel: picked.model.reasoning ? 'medium' : 'off',
  });

  const onAbort = () => {
    void harness.abort();
  };
  signal.addEventListener('abort', onAbort);
  if (signal.aborted) {
    onAbort();
  }

  // Did the current thinking block stream any real text delta? Some providers
  // (notably OpenAI reasoning summaries via the relay) stream empty
  // `thinking_delta` events and only deliver the full summary text in the
  // final `thinking_end`. We track this per block so we can backfill.
  let sawThinkingDelta = false;

  const unsubscribe = harness.subscribe((event) => {
    switch (event.type) {
      case 'message_start': {
        if ('message' in event && event.message.role === 'assistant') {
          emit({ type: 'assistant_start' });
        }
        break;
      }
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        // Forward only real string deltas. Reasoning models with encrypted/
        // redacted thinking (e.g. OpenAI responses) emit thinking_delta events
        // whose `delta` is undefined; forwarding those would render "undefined".
        if (inner.type === 'text_delta' && inner.delta) {
          emit({ type: 'text', delta: inner.delta });
        } else if (inner.type === 'thinking_start') {
          sawThinkingDelta = false;
        } else if (inner.type === 'thinking_delta' && inner.delta) {
          // Only real (non-whitespace) text counts as "seen". Some relays emit
          // a lone "\n\n" separator as the only delta while the actual summary
          // arrives in thinking_end; that must not suppress the backfill below.
          if (inner.delta.trim()) sawThinkingDelta = true;
          emit({ type: 'thinking', delta: inner.delta });
        } else if (inner.type === 'thinking_end') {
          // Relays that strip streaming summary deltas still send the full
          // text here. Backfill it so the thinking is shown at least once.
          const content = (inner as { content?: string }).content;
          if (!sawThinkingDelta && content) {
            emit({ type: 'thinking', delta: content });
          }
        }
        break;
      }
      case 'tool_execution_start': {
        emit({
          type: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          args: (event.args ?? {}) as JsonValue,
        });
        break;
      }
      case 'tool_execution_update': {
        const output = extractToolText(event.partialResult);
        if (output) {
          emit({
            type: 'tool_update',
            id: event.toolCallId,
            name: event.toolName,
            output: clip(output),
          });
        }
        break;
      }
      case 'tool_execution_end': {
        emit({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          output: clip(extractToolText(event.result)),
        });
        break;
      }
      case 'turn_end': {
        emit({ type: 'turn_end' });
        break;
      }
      default:
        break;
    }
  });

  const images = (opts.images ?? []).map((i) => ({
    type: 'image' as const,
    data: i.data,
    mimeType: i.mimeType,
  }));

  try {
    await harness.prompt(userText, images.length > 0 ? { images } : undefined);
    return {
      messages: (await session.buildContext())
        .messages as unknown as JsonValue[],
    };
  } catch (error) {
    return {
      messages: (await session.buildContext())
        .messages as unknown as JsonValue[],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}
