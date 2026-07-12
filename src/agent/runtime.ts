/**
 * Run one Agent turn for a session and stream events out. Executes inside
 * the Agent Runner process: all platform state flows through the injected
 * PlatformClient, never through direct server imports.
 */
import { mkdirSync } from 'node:fs';
import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { Models } from '@earendil-works/pi-ai';
import type { JsonValue } from '~/db/schema';
import { formatAttachmentPrompt, type AgentAttachmentRef } from './attachments';
import type { AgentStreamEvent } from './events';
import { agentWorkDir, SKILLS_DIR } from './paths';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import { agentShellEnv } from './shell-env';
import { loadAgentSkills } from './skills';
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
  attachments?: AgentAttachmentRef[];
  models: Models;
  picked: ResolvedModel;
  platform: PlatformClient;
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

  const skills = await loadAgentSkills(env);
  const tools = createTools(env, {
    platform: opts.platform,
    ...(opts.ask ? { ask: opts.ask } : {}),
    readOnlyRoots: [SKILLS_DIR],
    sessionId,
  });
  // Server-side source of truth for tool display labels. Emitting the label on
  // tool_start lets the client show it without maintaining a second copy of
  // every tool name (which drifted out of date and showed raw snake_case).
  const labelByName = new Map(tools.map((tool) => [tool.name, tool.label]));

  const harness = new AgentHarness({
    env,
    session,
    models,
    model: picked.model,
    tools,
    resources: { skills },
    systemPrompt: ({ resources }) => buildSystemPrompt(resources.skills ?? []),
    thinkingLevel: picked.model.reasoning ? 'medium' : 'off',
  });

  const onAbort = () => {
    // Swallow abort rejections: a rejected abort() would otherwise become a
    // process-level unhandledRejection that can crash the server.
    void Promise.resolve(harness.abort()).catch(() => {});
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
        const label = labelByName.get(event.toolName);
        emit({
          type: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          ...(label ? { label } : {}),
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

  const buildTranscript = async (): Promise<JsonValue[]> => {
    const messages = (await session.buildContext())
      .messages as unknown as JsonValue[];
    const attachments = opts.attachments ?? [];
    if (attachments.length === 0) return messages;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        message &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'user'
      ) {
        messages[index] = {
          ...message,
          attachments: attachments as unknown as JsonValue,
        };
        break;
      }
    }
    return messages;
  };

  try {
    const assistant = await harness.prompt(
      formatAttachmentPrompt(userText, opts.attachments ?? []),
      images.length > 0 ? { images } : undefined,
    );
    const messages = await buildTranscript();

    // AgentHarness reports provider/stream failures as a resolved assistant
    // message rather than rejecting prompt(). Propagate those terminal reasons
    // to the runner while keeping the full transcript (including partial text).
    if (
      assistant.stopReason === 'error' ||
      assistant.stopReason === 'aborted'
    ) {
      return {
        messages,
        error:
          assistant.errorMessage ||
          (assistant.stopReason === 'aborted'
            ? 'Agent run was aborted.'
            : 'Agent run failed.'),
      };
    }

    return { messages };
  } catch (error) {
    return {
      messages: await buildTranscript(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}
