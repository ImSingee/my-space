import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AgentRunStatus, JsonObject, JsonValue } from '~/db/schema';
import { submitAnswer, waitForAnswer } from '~agent/ask-registry';
import { loadAgentModels, pickModel } from '~agent/build-models';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
} from '~agent/events';
import { runAgentTurn } from '~agent/runtime';
import { AppError } from '~server/errors';

type SendImage = { data: string; mimeType: string };

export type AgentRunInput = {
  sessionId: string;
  userText: string;
  images?: SendImage[];
  providerId?: string | null;
  modelId?: string | null;
};

export type PendingAskPayload = {
  askId: string;
  questions: AskQuestion[];
};

export type ActiveAgentRun = {
  id: string;
  status: AgentRunStatus;
  pendingAsk: PendingAskPayload | null;
};

type Subscriber = (event: AgentRunStreamEvent) => void;

type EventPipeline = {
  emit: (event: AgentStreamEvent) => void;
  emitAsync: (event: AgentStreamEvent) => Promise<AgentRunStreamEvent>;
  flush: () => Promise<void>;
};

type LiveRun = {
  controller: AbortController;
  subscribers: Set<Subscriber>;
  cancelled: boolean;
  pipeline?: EventPipeline;
  /** Resolves once executeRun has persisted messages and finalized the run. */
  finished: Promise<void>;
};

type AgentRunsGlobal = typeof globalThis & {
  __hatchAgentRuns__?: Map<string, LiveRun>;
};

const ACTIVE_STATUSES: AgentRunStatus[] = ['running', 'blocked'];
const TERMINAL_STATUSES: AgentRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

function liveRuns(): Map<string, LiveRun> {
  const g = globalThis as AgentRunsGlobal;
  g.__hatchAgentRuns__ ??= new Map<string, LiveRun>();
  return g.__hatchAgentRuns__;
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function deriveTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.length > 48
    ? `${firstLine.slice(0, 48)}…`
    : firstLine || 'New chat';
}

function userMessage(userText: string, images: SendImage[] = []): JsonObject {
  const content: JsonValue[] = [];
  if (userText.trim()) content.push({ type: 'text', text: userText });
  for (const image of images) {
    content.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return { role: 'user', content };
}

function asPendingAsk(value: JsonObject | null): PendingAskPayload | null {
  if (!value) return null;
  return value as unknown as PendingAskPayload;
}

function publish(runId: string, event: AgentRunStreamEvent): void {
  const live = liveRuns().get(runId);
  if (!live) return;
  for (const subscriber of live.subscribers) {
    subscriber(event);
  }
}

async function nextSeq(runId: string): Promise<number> {
  const last = await db.query.agentRunEvents.findFirst({
    where: (e, { eq: equals }) => equals(e.runId, runId),
    orderBy: (e, { desc: descending }) => [descending(e.seq)],
  });
  return (last?.seq ?? 0) + 1;
}

async function appendEvent(
  runId: string,
  seq: number,
  event: AgentStreamEvent,
): Promise<AgentRunStreamEvent> {
  await db.insert(schema.agentRunEvents).values({
    runId,
    seq,
    type: event.type,
    payload: event as unknown as JsonObject,
  });
  const stored = { seq, event };
  publish(runId, stored);
  return stored;
}

async function appendStandaloneEvent(
  runId: string,
  event: AgentStreamEvent,
): Promise<AgentRunStreamEvent> {
  return appendEvent(runId, await nextSeq(runId), event);
}

async function createEventPipeline(runId: string): Promise<{
  emit: (event: AgentStreamEvent) => void;
  emitAsync: (event: AgentStreamEvent) => Promise<AgentRunStreamEvent>;
  flush: () => Promise<void>;
}> {
  let seq = await nextSeq(runId);
  let tail = Promise.resolve();
  let failure: unknown;

  const enqueue = (event: AgentStreamEvent) => {
    const runSeq = seq;
    seq += 1;
    tail = tail
      .then(() => appendEvent(runId, runSeq, event))
      .then(
        () => undefined,
        (error) => {
          failure = error;
          throw error;
        },
      );
    return tail.then(() => ({ seq: runSeq, event }));
  };

  return {
    emit: (event) => {
      void enqueue(event).catch(() => undefined);
    },
    emitAsync: enqueue,
    flush: async () => {
      await tail;
      if (failure) throw failure;
    },
  };
}

async function updateActiveRunStatus(
  runId: string,
  status: AgentRunStatus,
  patch: {
    error?: string | null;
    pendingAsk?: PendingAskPayload | null;
    completed?: boolean;
  } = {},
): Promise<boolean> {
  const rows = await db
    .update(schema.agentRuns)
    .set({
      status,
      error: patch.error ?? null,
      pendingAsk: (patch.pendingAsk ?? null) as unknown as JsonObject | null,
      completedAt: patch.completed ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  return rows.length > 0;
}

async function finishRun(
  runId: string,
  status: AgentRunStatus,
  error?: string,
): Promise<boolean> {
  const rows = await db
    .update(schema.agentRuns)
    .set({
      status,
      error: error ?? null,
      pendingAsk: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  return rows.length > 0;
}

function isActiveRunConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const pgError =
    'cause' in error && error.cause && typeof error.cause === 'object'
      ? error.cause
      : error;
  const code = (pgError as { code?: unknown }).code;
  const constraint = (pgError as { constraint?: unknown }).constraint;
  return code === '23505' && constraint === 'agent_runs_active_session_idx';
}

export async function getActiveAgentRun(
  sessionId: string,
): Promise<ActiveAgentRun | null> {
  const row = await db.query.agentRuns.findFirst({
    where: (r, { and: all, eq: equals, inArray: within }) =>
      all(equals(r.sessionId, sessionId), within(r.status, ACTIVE_STATUSES)),
    orderBy: (r, { desc: descending }) => [descending(r.createdAt)],
  });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    pendingAsk: asPendingAsk(row.pendingAsk ?? null),
  };
}

export async function getAgentRun(runId: string) {
  return db.query.agentRuns.findFirst({
    where: (r, { eq: equals }) => equals(r.id, runId),
  });
}

export async function listRunEventsAfter(
  runId: string,
  afterSeq: number,
  limit = 1000,
): Promise<AgentRunStreamEvent[]> {
  // Bound each query: a long or noisy run can persist thousands of events, so
  // callers page through with `limit` instead of loading the whole tail into
  // memory at once (see the SSE replay loop).
  const rows = await db.query.agentRunEvents.findMany({
    where: (e) => and(eq(e.runId, runId), gt(e.seq, afterSeq)),
    orderBy: (e, { asc }) => [asc(e.seq)],
    limit,
  });
  return rows.map((row) => ({
    seq: row.seq,
    event: row.payload as unknown as AgentStreamEvent,
  }));
}

export function subscribeToAgentRun(
  runId: string,
  subscriber: Subscriber,
): () => void {
  const live = liveRuns().get(runId);
  if (!live) return () => {};
  live.subscribers.add(subscriber);
  return () => {
    live.subscribers.delete(subscriber);
  };
}

export function isAgentRunLive(runId: string): boolean {
  return liveRuns().has(runId);
}

export async function startAgentRun(input: AgentRunInput): Promise<{
  runId: string;
}> {
  const sessionRow = await db.query.agentSessions.findFirst({
    where: (s, { eq: equals }) => equals(s.id, input.sessionId),
  });
  if (!sessionRow) throw new AppError('Session not found.', 404);

  const activeRun = await getActiveAgentRun(input.sessionId);
  if (activeRun) {
    throw new AppError('This chat already has a running Agent turn.', 409);
  }

  const { models, list } = await loadAgentModels();
  if (list.length === 0) {
    throw new Error(
      'No models configured. Add a provider and model in Settings first.',
    );
  }

  const picked = pickModel(
    list,
    input.providerId ?? sessionRow.providerId,
    input.modelId ?? sessionRow.modelId,
  );
  if (!picked) throw new Error('Selected model is unavailable.');

  const baseMessages = (sessionRow.messages ?? []) as unknown as AgentMessage[];
  const title =
    sessionRow.title && sessionRow.title !== 'New chat'
      ? sessionRow.title
      : deriveTitle(input.userText);
  const images = input.images ?? [];

  let run: typeof schema.agentRuns.$inferSelect;
  try {
    [run] = await db
      .insert(schema.agentRuns)
      .values({
        sessionId: input.sessionId,
        providerId: picked.providerId,
        modelId: picked.model.id,
        status: 'running',
        input: {
          userText: input.userText,
          images,
        },
      })
      .returning();
  } catch (error) {
    if (isActiveRunConflict(error)) {
      throw new AppError('This chat already has a running Agent turn.', 409);
    }
    throw error;
  }

  await db
    .update(schema.agentSessions)
    .set({
      messages: [
        ...((sessionRow.messages ?? []) as JsonValue[]),
        userMessage(input.userText, images),
      ],
      title,
      providerId: picked.providerId,
      modelId: picked.model.id,
    })
    .where(eq(schema.agentSessions.id, input.sessionId));

  const live: LiveRun = {
    controller: new AbortController(),
    subscribers: new Set(),
    cancelled: false,
    finished: Promise.resolve(),
  };
  liveRuns().set(run.id, live);

  // Hold the run's completion so cancel can wait for the partial reply to be
  // persisted before returning (the client refetches right after cancelling).
  live.finished = executeRun(run.id, live, {
    sessionId: input.sessionId,
    userText: input.userText,
    images,
    baseMessages,
    title,
    models,
    picked,
  }).catch(() => {});

  return { runId: run.id };
}

async function executeRun(
  runId: string,
  live: LiveRun,
  opts: {
    sessionId: string;
    userText: string;
    images: SendImage[];
    baseMessages: AgentMessage[];
    title: string;
    models: Awaited<ReturnType<typeof loadAgentModels>>['models'];
    picked: NonNullable<ReturnType<typeof pickModel>>;
  },
): Promise<void> {
  const pipeline = await createEventPipeline(runId);
  live.pipeline = pipeline;

  const emitTerminal = async (
    status: AgentRunStatus,
    event: AgentStreamEvent,
    error?: string,
  ) => {
    if (await finishRun(runId, status, error)) {
      await pipeline.emitAsync(event);
    }
  };

  const isCancelled = () => live.cancelled || live.controller.signal.aborted;

  const ask = async (
    questions: AskQuestion[],
    askSignal?: AbortSignal,
  ): Promise<AskAnswer[]> => {
    if (isCancelled()) {
      throw new Error('Agent run was cancelled.');
    }
    const askId = crypto.randomUUID();
    const pendingAsk = { askId, questions };
    if (!(await updateActiveRunStatus(runId, 'blocked', { pendingAsk }))) {
      throw new Error('Agent run is no longer active.');
    }
    if (isCancelled()) {
      throw new Error('Agent run was cancelled.');
    }
    await pipeline.emitAsync({ type: 'ask', askId, questions });
    const answers = await waitForAnswer(
      runId,
      askId,
      askSignal ?? live.controller.signal,
    );
    if (
      !(await updateActiveRunStatus(runId, 'running', {
        pendingAsk: null,
      }))
    ) {
      throw new Error('Agent run is no longer active.');
    }
    if (isCancelled()) {
      throw new Error('Agent run was cancelled.');
    }
    await pipeline.emitAsync({ type: 'ask_answered', askId });
    return answers;
  };

  try {
    if (isCancelled()) {
      await emitTerminal('cancelled', { type: 'cancelled' });
      return;
    }

    const result = await runAgentTurn({
      priorMessages: opts.baseMessages,
      sessionId: opts.sessionId,
      userText: opts.userText,
      images: opts.images,
      models: opts.models,
      picked: opts.picked,
      signal: live.controller.signal,
      ask,
      emit: pipeline.emit,
    });
    await pipeline.flush();

    // Persist whatever the turn produced — including a reply that was only
    // partially streamed before the user stopped the run (or before it errored).
    // runAgentTurn returns the messages accumulated so far on abort, so saving
    // here keeps already-shown output in history instead of discarding it.
    await db
      .update(schema.agentSessions)
      .set({
        messages: result.messages,
        title: opts.title,
        providerId: opts.picked.providerId,
        modelId: opts.picked.model.id,
      })
      .where(eq(schema.agentSessions.id, opts.sessionId));

    if (live.cancelled || live.controller.signal.aborted) {
      await emitTerminal('cancelled', { type: 'cancelled' });
      return;
    }

    if (result.error) {
      await emitTerminal(
        'failed',
        { type: 'error', message: result.error },
        result.error,
      );
    } else {
      await emitTerminal('completed', {
        type: 'done',
        messages: result.messages,
        title: opts.title,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (live.cancelled || live.controller.signal.aborted) {
      await emitTerminal('cancelled', { type: 'cancelled' });
    } else {
      await emitTerminal('failed', { type: 'error', message }, message);
    }
  } finally {
    try {
      await pipeline.flush();
    } finally {
      live.pipeline = undefined;
      liveRuns().delete(runId);
    }
  }
}

/**
 * Validate the user's answers against the exact questions that are still
 * pending. The HTTP route only shape-checks the payload, so without this a
 * crafted POST could resume the run with answers for unknown questions, options
 * that were never offered, multiple picks for a single-choice question, or no
 * answer at all — feeding the agent garbage decisions.
 */
function validateAskAnswers(
  questions: AskQuestion[],
  answers: AskAnswer[],
): void {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      throw new Error(`Unknown question "${answer.questionId}".`);
    }
    if (seen.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}".`);
    }
    seen.add(answer.questionId);

    const validOptionIds = new Set(question.options.map((o) => o.id));
    for (const optionId of answer.selectedOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw new Error(
          `Invalid option "${optionId}" for question "${answer.questionId}".`,
        );
      }
    }
    // Custom ("Other") text counts as a choice too: the radio UI makes it
    // mutually exclusive with the options, so a single-choice answer must carry
    // exactly one of {an option, custom text} — never both. Reject duplicate
    // option ids first, otherwise ['o1','o1'] would collapse to one choice and
    // sneak past the single-choice cap (and double a label to the model).
    const uniqueSelected = new Set(answer.selectedOptionIds);
    if (uniqueSelected.size !== answer.selectedOptionIds.length) {
      throw new Error(
        `Duplicate option in answer for question "${answer.questionId}".`,
      );
    }
    const hasCustom = Boolean(answer.customText && answer.customText.trim());
    const choiceCount = uniqueSelected.size + (hasCustom ? 1 : 0);
    if (choiceCount === 0) {
      throw new Error(`Question "${answer.questionId}" needs an answer.`);
    }
    if (!question.allowMultiple && choiceCount > 1) {
      throw new Error(
        `Question "${answer.questionId}" accepts only one option.`,
      );
    }
  }
  for (const question of questions) {
    if (!seen.has(question.id)) {
      throw new Error(`Missing answer for question "${question.id}".`);
    }
  }
}

export async function answerAgentRun(
  runId: string,
  askId: string,
  answers: AskAnswer[],
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) {
    throw new Error('Agent run is no longer waiting.');
  }
  const pendingAsk = asPendingAsk(run.pendingAsk ?? null);
  if (!pendingAsk || pendingAsk.askId !== askId) {
    throw new Error('Question is no longer waiting.');
  }
  validateAskAnswers(pendingAsk.questions, answers);
  if (!submitAnswer(runId, askId, answers)) {
    throw new Error('Agent run is no longer active.');
  }
}

export async function cancelAgentRun(runId: string): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;

  const live = liveRuns().get(runId);
  if (live) {
    live.cancelled = true;
    live.controller.abort();
    if (await finishRun(runId, 'cancelled')) {
      const event: AgentStreamEvent = { type: 'cancelled' };
      if (live.pipeline) {
        await live.pipeline.emitAsync(event);
      } else {
        await appendStandaloneEvent(runId, event);
      }
    }
    // Wait for executeRun to persist the partial reply and clean up so the
    // client's post-cancel refetch sees the streamed-so-far output. Cap the
    // wait so a stuck abort can't hang the cancel request indefinitely.
    await Promise.race([
      live.finished,
      new Promise<void>((resolve) => setTimeout(resolve, 15000)),
    ]);
    return;
  }

  if (await finishRun(runId, 'cancelled')) {
    await appendStandaloneEvent(runId, { type: 'cancelled' });
  }
}

export async function interruptAgentRun(
  runId: string,
  message = 'Agent run was interrupted.',
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;
  if (await finishRun(runId, 'interrupted', message)) {
    await appendStandaloneEvent(runId, { type: 'error', message });
  }
}

export async function interruptStaleAgentRuns(): Promise<void> {
  const rows = await db.query.agentRuns.findMany({
    where: (r, { inArray: within }) => within(r.status, ACTIVE_STATUSES),
  });
  await Promise.all(
    rows.map((run) =>
      interruptAgentRun(
        run.id,
        'Agent run was interrupted because the server restarted.',
      ),
    ),
  );
}
