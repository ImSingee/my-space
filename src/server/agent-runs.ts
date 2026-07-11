/**
 * Server-only: the CONTROL PLANE for agent runs.
 *
 * Execution happens in the separate Agent Runner service; this module owns
 * the database state machine (run rows, event log, leases), dispatches new
 * runs to a connected runner through the hub, ingests the runner's event
 * stream (deduped on `runnerSeq`), and fans events out to SSE subscribers.
 *
 * A run's lifecycle:
 *   startAgentRun → dispatch to runner (lease assigned)
 *   → runner streams `run.event`s (ask/tool/text/…; each renews the lease)
 *   → runner reports `run.finished` (messages persisted, terminal event)
 *   Cancel/answer flow platform → runner over the same control channel.
 *   A sweeper interrupts active runs whose lease expired (runner died).
 */
import { and, eq, inArray, gt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '~/db';
import type { AgentRunStatus, JsonObject, JsonValue } from '~/db/schema';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
} from '~agent/events';
import {
  LEASE_SWEEP_INTERVAL_MS,
  RUN_LEASE_TTL_MS,
  type RunModelConfig,
  type SendImage,
} from '~agent/protocol';
import { AppError } from '~server/errors';
import { parseRetryableAgentTurn } from './agent-retry';

export type AgentRunInput =
  | {
      sessionId: string;
      retry: true;
    }
  | {
      sessionId: string;
      retry?: false;
      userText: string;
      images?: SendImage[];
      providerId?: string | null;
      modelId?: string | null;
    };

export type PendingAskPayload = {
  askId: string;
  questions: AskQuestion[];
};

type PendingAnswerPayload = {
  askId: string;
  answers: AskAnswer[];
};

export type ActiveAgentRun = {
  id: string;
  status: AgentRunStatus;
  pendingAsk: PendingAskPayload | null;
};

type Subscriber = (event: AgentRunStreamEvent) => void;

type AgentRunsGlobal = typeof globalThis & {
  /** SSE subscribers per run (control plane fan-out). */
  __hatchAgentRunSubs__?: Map<string, Set<Subscriber>>;
  /** Per-run ingest chains: serialize event processing in arrival order. */
  __hatchAgentRunChains__?: Map<string, Promise<unknown>>;
  __hatchAgentRunSweeper__?: ReturnType<typeof setInterval>;
};

export const ACTIVE_STATUSES: AgentRunStatus[] = ['running', 'blocked'];
const TERMINAL_STATUSES: AgentRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

function subscriberMap(): Map<string, Set<Subscriber>> {
  const g = globalThis as AgentRunsGlobal;
  g.__hatchAgentRunSubs__ ??= new Map();
  return g.__hatchAgentRunSubs__;
}

function chainMap(): Map<string, Promise<unknown>> {
  const g = globalThis as AgentRunsGlobal;
  g.__hatchAgentRunChains__ ??= new Map();
  return g.__hatchAgentRunChains__;
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** True while the run's runner lease is still valid. */
export function hasLiveLease(run: { leaseExpiresAt: Date | null }): boolean {
  return (
    run.leaseExpiresAt != null && run.leaseExpiresAt.getTime() > Date.now()
  );
}

function leaseDeadline(): Date {
  return new Date(Date.now() + RUN_LEASE_TTL_MS);
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

function asPendingAnswer(
  value: JsonObject | null,
): PendingAnswerPayload | null {
  if (!value) return null;
  return value as unknown as PendingAnswerPayload;
}

function publish(runId: string, event: AgentRunStreamEvent): void {
  const set = subscriberMap().get(runId);
  if (!set) return;
  for (const subscriber of set) {
    subscriber(event);
  }
}

/**
 * Serialize work for one run onto a promise chain so runner events are
 * persisted in arrival order even though each WS message handler is async.
 */
function enqueueRunTask<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const chains = chainMap();
  const tail = chains.get(runId) ?? Promise.resolve();
  const result = tail.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(runId, settled);
  void settled.then(() => {
    if (chains.get(runId) === settled) chains.delete(runId);
  });
  return result;
}

/**
 * Append an event, allocating its `seq` as `max(seq)+1` for the run. A per-run
 * advisory lock (held to the end of the transaction) serializes concurrent
 * allocations across connections/processes. When `runnerSeq` is given, the
 * unique (run_id, runner_seq) index dedupes resends after a runner reconnect:
 * a duplicate inserts nothing and returns null.
 */
async function persistEvent(
  runId: string,
  event: AgentStreamEvent,
  runnerSeq?: number,
): Promise<AgentRunStreamEvent | null> {
  const payload = JSON.stringify(event);
  const seq = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    const rows = await tx.execute<{ seq: number }>(sql`
      insert into agent_run_events (id, run_id, seq, runner_seq, type, payload)
      select ${ulid().toLowerCase()}, ${runId},
             coalesce(max(seq), 0) + 1, ${runnerSeq ?? null},
             ${event.type}, ${payload}::jsonb
      from agent_run_events where run_id = ${runId}
      on conflict (run_id, runner_seq) do nothing
      returning seq
    `);
    const inserted = (rows as unknown as { seq: number }[])[0];
    return inserted ? Number(inserted.seq) : null;
  });
  if (seq == null) return null;
  return { seq, event };
}

async function appendEvent(
  runId: string,
  event: AgentStreamEvent,
  runnerSeq?: number,
): Promise<AgentRunStreamEvent | null> {
  const stored = await persistEvent(runId, event, runnerSeq);
  if (stored) publish(runId, stored);
  return stored;
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
      pendingAnswer: null,
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
  const map = subscriberMap();
  const set = map.get(runId) ?? new Set<Subscriber>();
  map.set(runId, set);
  set.add(subscriber);
  return () => {
    set.delete(subscriber);
    if (set.size === 0 && map.get(runId) === set) map.delete(runId);
  };
}

/** ================== model resolution ================== */

/**
 * Resolve the model for a run into the self-contained config the runner
 * needs (including the provider API key, scoped to just this provider).
 * Falls back to the first enabled model when the requested one is gone.
 */
async function resolveRunModelConfig(
  providerId?: string | null,
  modelId?: string | null,
): Promise<RunModelConfig | null> {
  const providers = await db.query.agentProviders.findMany({
    where: (p, { eq: equals }) => equals(p.enabled, true),
    orderBy: (p, { asc }) => [asc(p.sortOrder), asc(p.createdAt)],
  });

  type Candidate = {
    provider: (typeof providers)[number];
    model: typeof schema.agentModels.$inferSelect;
  };
  const candidates: Candidate[] = [];
  for (const provider of providers) {
    const models = await db.query.agentModels.findMany({
      where: (m, { eq: equals, and: all }) =>
        all(equals(m.providerId, provider.id), equals(m.enabled, true)),
      orderBy: (m, { asc }) => [asc(m.sortOrder), asc(m.createdAt)],
    });
    for (const model of models) candidates.push({ provider, model });
  }
  if (candidates.length === 0) return null;

  const picked =
    (providerId && modelId
      ? candidates.find(
          (c) => c.provider.id === providerId && c.model.modelId === modelId,
        )
      : undefined) ?? candidates[0];

  return {
    providerId: picked.provider.id,
    providerName: picked.provider.name,
    apiType: picked.provider.apiType,
    baseUrl: picked.provider.baseUrl,
    apiKey: picked.provider.apiKey,
    model: {
      id: picked.model.modelId,
      name: picked.model.name,
      reasoning: picked.model.reasoning,
      input: picked.model.input as ('text' | 'image')[],
      contextWindow: picked.model.contextWindow,
      maxTokens: picked.model.maxTokens,
    },
  };
}

/** ================== start / dispatch ================== */

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

  const sessionMessages = (sessionRow.messages ?? []) as JsonValue[];
  let baseMessages: JsonValue[];
  let userText: string;
  let images: SendImage[];
  let requestedProviderId: string | null;
  let requestedModelId: string | null;

  if (input.retry === true) {
    const retry = parseRetryableAgentTurn(sessionMessages);
    if (!retry) {
      throw new AppError('There is no failed Agent turn to retry.', 409);
    }
    baseMessages = retry.baseMessages;
    userText = retry.userText;
    images = retry.images;
    // A retry replays the persisted turn with its persisted session model; no
    // client-supplied prompt, images, provider, or model participates.
    requestedProviderId = sessionRow.providerId;
    requestedModelId = sessionRow.modelId;
  } else {
    baseMessages = sessionMessages;
    userText = input.userText;
    images = input.images ?? [];
    requestedProviderId = input.providerId ?? sessionRow.providerId;
    requestedModelId = input.modelId ?? sessionRow.modelId;
  }

  const model = await resolveRunModelConfig(
    requestedProviderId,
    requestedModelId,
  );
  if (!model) {
    throw new Error(
      'No models configured. Add a provider and model in Settings first.',
    );
  }

  const hub = await import('./agent-runner/hub');
  if (hub.connectedRunnerCount() === 0) {
    throw new AppError(
      'No Agent Runner is connected. Start the agent-runner service, then retry.',
      503,
    );
  }

  const title =
    sessionRow.title && sessionRow.title !== 'New chat'
      ? sessionRow.title
      : deriveTitle(userText);

  let run: typeof schema.agentRuns.$inferSelect;
  try {
    run = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.agentRuns)
        .values({
          sessionId: input.sessionId,
          providerId: model.providerId,
          modelId: model.model.id,
          status: 'running',
          // Covers the dispatch window; the accepting runner renews from here.
          leaseExpiresAt: leaseDeadline(),
          // Diagnostics only (no reader reconstructs the run from this). Store
          // image metadata, not the base64 payloads — those already live in the
          // persisted session message, and duplicating them here bloated the row.
          input: {
            userText,
            images: images.map((image) => ({ mimeType: image.mimeType })),
          },
        })
        .returning();

      // Keep run creation and transcript replacement in one commit. In
      // particular, a retry must never delete the failed turn unless the new
      // run row was created successfully.
      await tx
        .update(schema.agentSessions)
        .set({
          messages: [...baseMessages, userMessage(userText, images)],
          title,
          providerId: model.providerId,
          modelId: model.model.id,
        })
        .where(eq(schema.agentSessions.id, input.sessionId));

      return inserted;
    });
  } catch (error) {
    if (isActiveRunConflict(error)) {
      throw new AppError('This chat already has a running Agent turn.', 409);
    }
    throw error;
  }

  try {
    await hub.dispatchRun({
      runId: run.id,
      sessionId: input.sessionId,
      userText,
      images,
      priorMessages: baseMessages,
      model,
    });
  } catch (error) {
    // Dispatch failed (runner vanished between the check and the send, or
    // never accepted). Fail the run gracefully: the client's SSE connection
    // replays the error event instead of hanging on "Thinking…". Serialized
    // on the per-run chain against any events the runner did manage to send.
    const message =
      error instanceof Error ? error.message : 'Failed to dispatch the run.';
    await enqueueRunTask(run.id, async () => {
      if (await finishRun(run.id, 'failed', message)) {
        await appendEvent(run.id, { type: 'error', message });
      }
    });
  }

  return { runId: run.id };
}

/** ================== hub callbacks (runner lifecycle) ================== */

/** Record which runner owns a run and start its lease (called on dispatch). */
export async function assignRunToRunner(
  runId: string,
  runnerId: string,
): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({ runnerId, leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
}

/** Heartbeat: extend the lease of every active run owned by this runner. */
export async function renewRunnerLeases(runnerId: string): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentRuns.runnerId, runnerId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    );
}

export type RunnerReconciliation = {
  /**
   * Runs the runner should keep reporting on: still-owned active runs (keep
   * executing, resend outbound queues) AND owned runs that went terminal on
   * the platform while the runner was away — those still hold an unacked
   * final report whose resend persists the partial transcript and repairs a
   * missing terminal stream event (crash between finishRun and appendEvent).
   */
  resumed: string[];
  /** Runs this runner does not own (anymore): abort + discard locally. */
  stale: string[];
  /** Answers submitted while the runner was offline, to deliver now. */
  pendingAnswers: { runId: string; askId: string; answers: AskAnswer[] }[];
};

/**
 * Reconcile a (re)connecting runner's claimed active runs against the
 * database: runs it still owns get their lease renewed and resume; runs the
 * DB says it owns but it no longer claims (runner restarted and lost its
 * memory) are interrupted so their sessions unblock.
 */
export async function reconcileRunnerRuns(
  runnerId: string,
  claimedRunIds: string[],
): Promise<RunnerReconciliation> {
  const resumed: string[] = [];
  const stale: string[] = [];
  const pendingAnswers: RunnerReconciliation['pendingAnswers'] = [];
  const claimed = new Set(claimedRunIds);

  for (const runId of claimedRunIds) {
    const run = await getAgentRun(runId);
    if (!run || run.runnerId !== runnerId) {
      // Unknown or reassigned: this runner's copy must never report again.
      stale.push(runId);
      continue;
    }
    const terminal = isTerminalAgentRunStatus(run.status);
    if (!terminal && hasLiveLease(run)) {
      resumed.push(runId);
      const pendingAnswer = asPendingAnswer(run.pendingAnswer ?? null);
      if (pendingAnswer) {
        pendingAnswers.push({
          runId,
          askId: pendingAnswer.askId,
          answers: pendingAnswer.answers,
        });
      }
      continue;
    }
    if (!terminal) {
      // The claim is real but the lease lapsed: the run is past the grace
      // window and the sweeper/SSE path may already have raced to kill it.
      // Resuming would make the outcome depend on who runs first, so
      // enforce the lease contract deterministically instead.
      await interruptAgentRun(
        runId,
        'Agent run was interrupted because its Agent Runner stayed ' +
          'disconnected past the lease window.',
      );
    }
    // Owned but (now) terminal: the runner only claims runs it has not had
    // a finish ack for, so let it resend its final report instead of
    // discarding it — completeRunFromRunner persists the partial transcript
    // and repairs a missing done/cancelled/error stream event, then the
    // finish ack clears the runner's buffer. Any stream events it resends
    // first are ingested as stale (terminal status) and answered with
    // run.cancel, so a still-executing turn also winds down here.
    resumed.push(runId);
  }

  if (resumed.length > 0) {
    // Only truly active runs get a fresh lease; terminal runs resumed for
    // their final report must not resurface in lease bookkeeping.
    await db
      .update(schema.agentRuns)
      .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          inArray(schema.agentRuns.id, resumed),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  }

  const owned = await db.query.agentRuns.findMany({
    where: (r, { and: all, eq: equals, inArray: within }) =>
      all(equals(r.runnerId, runnerId), within(r.status, ACTIVE_STATUSES)),
  });
  for (const run of owned) {
    if (!claimed.has(run.id)) {
      await interruptAgentRun(
        run.id,
        'Agent run was interrupted because the Agent Runner restarted.',
      );
    }
  }

  return { resumed, stale, pendingAnswers };
}

export type IngestResult = 'ok' | 'stale';

/**
 * Persist one runner stream event (deduped on runnerSeq), apply its status
 * side effects (ask → blocked, ask_answered → running), renew the lease, and
 * fan it out to SSE subscribers. Returns 'stale' when the run no longer
 * belongs to this runner so the hub can tell it to abort.
 */
export async function ingestRunnerEvent(
  runnerId: string,
  message: { runId: string; runnerSeq: number; event: AgentStreamEvent },
): Promise<IngestResult> {
  return enqueueRunTask(message.runId, async () => {
    const run = await getAgentRun(message.runId);
    if (!run || run.runnerId !== runnerId) return 'stale';
    if (isTerminalAgentRunStatus(run.status)) return 'stale';

    // Persist first, publish last: subscribers must not see an `ask` before
    // the run row records it as pending (a fast answer would 409 otherwise).
    const stored = await persistEvent(
      message.runId,
      message.event,
      message.runnerSeq,
    );

    // Apply run-row side effects even when the event itself is a duplicate
    // resend: a crash between persistEvent and this update would otherwise
    // skip the effect forever (the resend dedupes on runnerSeq). Resends
    // replay as an in-order suffix (acks are cumulative), and each effect is
    // idempotent, so replaying converges to the correct state.
    await applyRunnerEventSideEffects(message.runId, message.event);

    // Duplicate resend — already persisted and published once.
    if (!stored) return 'ok';
    publish(message.runId, stored);
    return 'ok';
  });
}

/** Run-row updates driven by a runner stream event (ask/answer/lease). */
async function applyRunnerEventSideEffects(
  runId: string,
  event: AgentStreamEvent,
): Promise<void> {
  if (event.type === 'ask') {
    await db
      .update(schema.agentRuns)
      .set({
        status: 'blocked',
        pendingAsk: {
          askId: event.askId,
          questions: event.questions,
        } as unknown as JsonObject,
        // Clear answers for OLDER asks, but keep one already queued for THIS
        // ask: a replayed `ask` (lost ack) or a race with answerAgentRun must
        // not drop the user's submitted answer while the runner is offline.
        pendingAnswer: sql`case
          when ${schema.agentRuns.pendingAnswer}->>'askId' = ${event.askId}
          then ${schema.agentRuns.pendingAnswer}
          else null
        end`,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else if (event.type === 'ask_answered') {
    await db
      .update(schema.agentRuns)
      .set({
        status: 'running',
        pendingAsk: null,
        pendingAnswer: null,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else {
    await db
      .update(schema.agentRuns)
      .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  }
}

/**
 * Process the runner's final report for a run: persist the transcript onto
 * the session, then (if the run is still active) finish it and append the
 * terminal event. Also handles the cancel race — a run the platform already
 * cancelled still gets its partial transcript persisted here.
 */
export async function completeRunFromRunner(
  runnerId: string,
  message: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    error?: string;
    messages: unknown[];
  },
): Promise<void> {
  await enqueueRunTask(message.runId, async () => {
    const run = await getAgentRun(message.runId);
    if (!run || run.runnerId !== runnerId) return;

    // Persist whatever the turn produced — including a reply that was only
    // partially streamed before the user stopped the run (or before it
    // errored). Only `messages` is written back: title/provider/model were
    // set at run start, so re-applying a snapshot here would revert renames
    // or model switches made mid-run. An empty transcript is never persisted
    // (it would wipe the session history the run started from). A late or
    // retried report must also never clobber a NEWER turn's history: once a
    // more recent run exists on the session, this transcript is stale (ULIDs
    // order by creation time, so id comparison finds newer runs).
    const newerRun = await db.query.agentRuns.findFirst({
      where: (r, { and: all, eq: equals, gt }) =>
        all(equals(r.sessionId, run.sessionId), gt(r.id, run.id)),
      columns: { id: true },
    });
    if (message.messages.length > 0 && !newerRun) {
      await db
        .update(schema.agentSessions)
        .set({ messages: message.messages as JsonValue[] })
        .where(eq(schema.agentSessions.id, run.sessionId));
    }

    if (isTerminalAgentRunStatus(run.status)) {
      // Retry of a final report whose ack was lost. A crash between finishRun
      // and appendEvent leaves the run terminal without a terminal event, so
      // SSE clients would treat the closed stream as a disconnect — repair it.
      await ensureTerminalEvent(message.runId, run.status, run.error);
      return;
    }

    const finished = await finishRun(
      message.runId,
      message.status,
      message.status === 'failed'
        ? (message.error ?? 'Agent run failed.')
        : undefined,
    );
    if (!finished) return;

    await appendEvent(
      message.runId,
      terminalEventForStatus(message.status, message.error),
    );
  });
}

function terminalEventForStatus(
  status: AgentRunStatus,
  error?: string | null,
): AgentStreamEvent {
  if (status === 'completed') return { type: 'done' };
  if (status === 'cancelled') return { type: 'cancelled' };
  return { type: 'error', message: error ?? 'Agent run failed.' };
}

/** Append the terminal event for an already-terminal run if it is missing. */
async function ensureTerminalEvent(
  runId: string,
  status: AgentRunStatus,
  error?: string | null,
): Promise<void> {
  const existing = await db.query.agentRunEvents.findFirst({
    where: (e, { and: all, eq: equals, inArray: within }) =>
      all(
        equals(e.runId, runId),
        within(e.type, ['done', 'cancelled', 'error']),
      ),
  });
  if (existing) return;
  await appendEvent(runId, terminalEventForStatus(status, error));
}

/** ================== ask / answer ================== */

/**
 * Validate the user's answers against the exact questions that are still
 * pending. The HTTP route only shape-checks the payload, so without this a
 * crafted POST could resume the run with answers for unknown questions,
 * options that were never offered, multiple picks for a single-choice
 * question, or no answer at all — feeding the agent garbage decisions.
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

/**
 * Accept the user's answers: validate against the pending question set,
 * persist them (so a disconnected runner receives them on reconnect), and
 * forward to the runner when it is online. The run flips back to `running`
 * only when the runner confirms with its `ask_answered` event.
 */
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

  const updated = await db
    .update(schema.agentRuns)
    .set({
      pendingAnswer: { askId, answers } as unknown as JsonObject,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  if (updated.length === 0) {
    throw new Error('Agent run is no longer active.');
  }

  const hub = await import('./agent-runner/hub');
  hub.sendRunAnswer(run.runnerId, runId, askId, answers);
}

/** ================== cancel / interrupt / sweep ================== */

export async function cancelAgentRun(runId: string): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;

  // On the per-run chain: a runner event mid-ingest must finish persisting
  // and publishing before the terminal event lands, because SSE clients
  // close the stream at the first terminal event. (The hub wait below stays
  // OFF the chain — completeRunFromRunner needs it to make progress.)
  await enqueueRunTask(runId, async () => {
    if (await finishRun(runId, 'cancelled')) {
      await appendEvent(runId, { type: 'cancelled' });
    }
  });

  // Tell the runner to abort, then wait (bounded) for its final report so the
  // client's post-cancel refetch sees the partial reply persisted onto the
  // session. When the runner is offline the run is already terminal; whatever
  // partial transcript arrives later is still persisted by
  // completeRunFromRunner.
  const hub = await import('./agent-runner/hub');
  if (hub.sendRunCancel(run.runnerId, runId)) {
    await hub.waitForRunFinished(runId, 15000);
  }
}

export async function interruptAgentRun(
  runId: string,
  message = 'Agent run was interrupted.',
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;
  // Same per-run serialization as cancelAgentRun (see comment there).
  await enqueueRunTask(runId, async () => {
    if (await finishRun(runId, 'interrupted', message)) {
      await appendEvent(runId, { type: 'error', message });
    }
  });
}

/**
 * Interrupt active runs whose lease expired — the runner died or stayed
 * disconnected past the grace window. Runs with live leases are left alone
 * (their runner may just be reconnecting), which also means agent runs now
 * SURVIVE platform restarts as long as the runner keeps running.
 */
export async function sweepExpiredAgentRuns(): Promise<void> {
  const rows = await db.query.agentRuns.findMany({
    where: (r, { inArray: within }) => within(r.status, ACTIVE_STATUSES),
  });
  const now = Date.now();
  for (const run of rows) {
    const expired =
      run.leaseExpiresAt == null || run.leaseExpiresAt.getTime() <= now;
    if (!expired) continue;
    await interruptAgentRun(
      run.id,
      'Agent run was interrupted because its Agent Runner went away.',
    );
  }
}

/** Start the periodic lease sweeper (idempotent across dev reloads). */
export function ensureAgentRunSweeper(): void {
  const g = globalThis as AgentRunsGlobal;
  if (g.__hatchAgentRunSweeper__) return;
  g.__hatchAgentRunSweeper__ = setInterval(() => {
    sweepExpiredAgentRuns().catch((error) => {
      console.error('[agent-runs] lease sweep failed:', error);
    });
  }, LEASE_SWEEP_INTERVAL_MS);
}
