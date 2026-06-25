/** Server-only: run one Agent turn for a session and stream events out. */
import {
  AgentHarness,
  InMemorySessionRepo,
  loadSkills,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { JsonValue } from '~/db/schema';
import { waitForAnswer } from './ask-registry';
import { loadAgentModels, pickModel } from './build-models';
import type { AgentStreamEvent } from './events';
import { SKILLS_DIR, WORKSPACE_ROOT } from './paths';
import { buildSystemPrompt } from './system-prompt';
import { createTools } from './tools';

function deriveTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.length > 48
    ? `${firstLine.slice(0, 48)}…`
    : firstLine || 'New chat';
}

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
  sessionId: string;
  userText: string;
  images?: { data: string; mimeType: string }[];
  providerId?: string | null;
  modelId?: string | null;
  signal: AbortSignal;
  emit: (event: AgentStreamEvent) => void;
};

export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<void> {
  const { sessionId, userText, signal, emit } = opts;

  const sessionRow = await db.query.agentSessions.findFirst({
    where: (s, { eq: e }) => e(s.id, sessionId),
  });
  if (!sessionRow) {
    emit({ type: 'error', message: 'Session not found.' });
    return;
  }

  const { models, list } = await loadAgentModels();
  if (list.length === 0) {
    emit({
      type: 'error',
      message:
        'No models configured. Add a provider and model in Settings first.',
    });
    return;
  }
  const picked = pickModel(
    list,
    opts.providerId ?? sessionRow.providerId,
    opts.modelId ?? sessionRow.modelId,
  );
  if (!picked) {
    emit({ type: 'error', message: 'Selected model is unavailable.' });
    return;
  }

  const env = new NodeExecutionEnv({
    cwd: WORKSPACE_ROOT,
    shellEnv: process.env,
  });

  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: sessionId });
  const priorMessages = (sessionRow.messages ??
    []) as unknown as AgentMessage[];
  for (const message of priorMessages) {
    await session.appendMessage(message);
  }

  const { skills } = await loadSkills(env, SKILLS_DIR);
  const tools = createTools(env, {
    ask: async (questions, askSignal) => {
      const askId = crypto.randomUUID();
      emit({ type: 'ask', askId, questions });
      return waitForAnswer(askId, askSignal ?? signal);
    },
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
  } catch (error) {
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }

  const context = await session.buildContext();
  const messages = context.messages as unknown as JsonValue[];

  const title =
    sessionRow.title && sessionRow.title !== 'New chat'
      ? sessionRow.title
      : deriveTitle(userText);

  await db
    .update(schema.agentSessions)
    .set({
      messages,
      title,
      providerId: picked.providerId,
      modelId: picked.model.id,
    })
    .where(eq(schema.agentSessions.id, sessionId));

  emit({ type: 'done', messages, title });
}
