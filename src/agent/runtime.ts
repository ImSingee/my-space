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
  const tools = createTools(env);

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
        // Only forward real string deltas. Reasoning models with encrypted/
        // redacted thinking (e.g. OpenAI responses) emit thinking_delta events
        // whose `delta` is undefined; forwarding those would render "undefined".
        if (inner.type === 'text_delta' && inner.delta) {
          emit({ type: 'text', delta: inner.delta });
        } else if (inner.type === 'thinking_delta' && inner.delta) {
          emit({ type: 'thinking', delta: inner.delta });
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
      case 'tool_execution_end': {
        emit({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
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
