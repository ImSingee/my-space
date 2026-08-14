import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
  EnvVariableField,
} from '~agent/events';
import type { JsonValue } from '~/db/schema';
import type { EnvEntry } from './env-form';

export type StreamTool = {
  id: string;
  name: string;
  /** Display label sent by the server on tool_start (avoids raw snake_case). */
  label?: string;
  /** Raw model arguments; malformed values remain visible to safe renderers. */
  args?: unknown;
  done: boolean;
  isError?: boolean;
  /** Live (while running) or final (on completion) tool output text. */
  output?: string;
  /** Structured final result details sent by the runtime. */
  details?: JsonValue;
};

export type PendingAsk = {
  askId: string;
  questions: AskQuestion[];
};

export type PendingEnvRequest = {
  requestId: string;
  reason: string;
  variables: EnvVariableField[];
};

export type StreamSeed = {
  pendingAsk: PendingAsk | null;
  pendingEnvRequest: PendingEnvRequest | null;
};

export type StreamThinkingBlock = { kind: 'thinking'; text: string };
export type StreamTextBlock = { kind: 'text'; text: string };
export type StreamToolBlock = { kind: 'tool'; tool: StreamTool };

/**
 * An ordered piece of the in-flight assistant turn. Mirroring the persisted
 * `AssistantBlock[]` shape (thinking / text / tool, in arrival order) lets the
 * live bubble render multiple distinct thinking segments interleaved with tools
 * and prose — exactly like the finished transcript — instead of collapsing all
 * reasoning into a single block.
 */
export type StreamBlock =
  | StreamThinkingBlock
  | StreamTextBlock
  | StreamToolBlock;

export type StreamState = {
  active: boolean;
  runId?: string;
  blocks: StreamBlock[];
  /** True while the latest thinking block is still streaming. */
  thinkingActive: boolean;
  pendingAsk?: PendingAsk;
  pendingEnvRequest?: PendingEnvRequest;
  /** Terminal failure received from the run SSE stream. */
  terminalError?: string;
};

const IDLE: StreamState = {
  active: false,
  runId: undefined,
  blocks: [],
  thinkingActive: false,
  pendingAsk: undefined,
  pendingEnvRequest: undefined,
};

const ENV_SUBMISSION_TIMEOUT_MS = 15000;
const ENV_CONFIRMATION_GRACE_MS = 750;
const MAX_CONFIRMED_ENV_REQUESTS = 32;

type StreamSource = {
  runId: string;
  generation: number;
};

type PromptBarrier = StreamSource &
  ({ kind: 'ask'; requestId: string } | { kind: 'env'; requestId: string });

type EnvSubmission = {
  id: string;
  runId: string;
  requestId: string;
  controller: AbortController;
  timedOut: boolean;
};

type ConfirmedEnvRequest = {
  runId: string;
  requestIds: Set<string>;
};

type SeedSnapshot = {
  runId: string;
  seed: StreamSeed | undefined;
  revision: number | undefined;
};

function envFailureToastId(runId: string, requestId: string): string {
  return `agent-env-save-failed:${runId}:${requestId}`;
}

function hasConfirmedEnvRequest(
  confirmed: ConfirmedEnvRequest | null,
  runId: string,
  requestId: string,
): boolean {
  return confirmed?.runId === runId && confirmed.requestIds.has(requestId);
}

function addConfirmedEnvRequest(
  confirmed: ConfirmedEnvRequest | null,
  runId: string,
  requestId: string,
): ConfirmedEnvRequest {
  const requestIds =
    confirmed?.runId === runId
      ? new Set(confirmed.requestIds)
      : new Set<string>();
  // Reinsert existing ids so the bounded set behaves like a small LRU.
  requestIds.delete(requestId);
  requestIds.add(requestId);
  while (requestIds.size > MAX_CONFIRMED_ENV_REQUESTS) {
    const oldest = requestIds.values().next().value;
    if (oldest === undefined) break;
    requestIds.delete(oldest);
  }
  return { runId, requestIds };
}

function sameEnvRequest(
  left: PendingEnvRequest | null | undefined,
  right: PendingEnvRequest | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.requestId === right.requestId &&
    left.reason === right.reason &&
    left.variables.length === right.variables.length &&
    left.variables.every(
      (variable, index) =>
        variable.key === right.variables[index]?.key &&
        variable.description === right.variables[index]?.description &&
        variable.secret === right.variables[index]?.secret,
    )
  );
}

function sameAsk(
  left: PendingAsk | null | undefined,
  right: PendingAsk | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (
    left.askId !== right.askId ||
    left.questions.length !== right.questions.length
  )
    return false;
  return left.questions.every((question, index) => {
    const other = right.questions[index];
    return (
      question.id === other?.id &&
      question.prompt === other.prompt &&
      question.allowMultiple === other.allowMultiple &&
      question.options.length === other.options.length &&
      question.options.every(
        (option, optionIndex) =>
          option.id === other.options[optionIndex]?.id &&
          option.label === other.options[optionIndex]?.label,
      )
    );
  });
}

export function sameStreamSeed(
  left: StreamSeed | undefined,
  right: StreamSeed | undefined,
): boolean {
  return (
    sameAsk(left?.pendingAsk, right?.pendingAsk) &&
    sameEnvRequest(left?.pendingEnvRequest, right?.pendingEnvRequest)
  );
}

function stateFromSeed(runId: string, seed?: StreamSeed): StreamState {
  const pendingEnvRequest = seed?.pendingEnvRequest ?? undefined;
  return {
    ...IDLE,
    active: true,
    runId,
    pendingAsk: pendingEnvRequest ? undefined : (seed?.pendingAsk ?? undefined),
    pendingEnvRequest,
  };
}

function barrierFromSeed(
  source: StreamSource,
  seed?: StreamSeed,
): PromptBarrier | null {
  if (seed?.pendingEnvRequest) {
    return {
      ...source,
      kind: 'env',
      requestId: seed.pendingEnvRequest.requestId,
    };
  }
  if (seed?.pendingAsk) {
    return {
      ...source,
      kind: 'ask',
      requestId: seed.pendingAsk.askId,
    };
  }
  return null;
}

function isPromptEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === 'ask' ||
    event.type === 'ask_answered' ||
    event.type === 'env_request' ||
    event.type === 'env_stored'
  );
}

/** Append `delta` to the last block when it matches `kind`, else start a new one. */
function appendDelta(
  blocks: StreamBlock[],
  kind: 'thinking' | 'text',
  delta: string,
  continueLast: boolean,
): StreamBlock[] {
  const last = blocks.at(-1);
  if (continueLast && last?.kind === kind) {
    const next = blocks.slice(0, -1);
    next.push({ kind, text: last.text + delta } as StreamBlock);
    return next;
  }
  return [...blocks, { kind, text: delta } as StreamBlock];
}

function updateTool(
  blocks: StreamBlock[],
  id: string,
  patch: (tool: StreamTool) => StreamTool,
): StreamBlock[] {
  return blocks.map((block) =>
    block.kind === 'tool' && block.tool.id === id
      ? { ...block, tool: patch(block.tool) }
      : block,
  );
}

export function reduceStreamState(
  state: StreamState,
  event: AgentStreamEvent,
): StreamState {
  switch (event.type) {
    case 'assistant_start':
      // A fresh assistant message: close any open thinking phase so the next
      // reasoning delta starts its own block.
      return { ...state, thinkingActive: false };
    case 'text':
      return {
        ...state,
        blocks: appendDelta(state.blocks, 'text', event.delta ?? '', true),
        thinkingActive: false,
      };
    case 'thinking':
      return {
        ...state,
        blocks: appendDelta(
          state.blocks,
          'thinking',
          event.delta ?? '',
          state.thinkingActive,
        ),
        thinkingActive: true,
      };
    case 'ask':
      return {
        ...state,
        thinkingActive: false,
        pendingAsk: { askId: event.askId, questions: event.questions },
        pendingEnvRequest: undefined,
      };
    case 'ask_answered':
      return state.pendingAsk?.askId === event.askId
        ? { ...state, pendingAsk: undefined }
        : state;
    case 'env_request':
      return {
        ...state,
        thinkingActive: false,
        pendingEnvRequest: {
          requestId: event.requestId,
          reason: event.reason,
          variables: event.variables,
        },
        pendingAsk: undefined,
      };
    case 'env_stored':
      return state.pendingEnvRequest?.requestId === event.requestId
        ? { ...state, pendingEnvRequest: undefined }
        : state;
    case 'tool_start':
      return {
        ...state,
        thinkingActive: false,
        blocks: [
          ...state.blocks,
          {
            kind: 'tool',
            tool: {
              id: event.id,
              name: event.name,
              ...(event.label ? { label: event.label } : {}),
              args: event.args,
              ...(event.details === undefined
                ? {}
                : { details: event.details }),
              done: false,
            },
          },
        ],
      };
    case 'tool_update':
      return {
        ...state,
        blocks: updateTool(state.blocks, event.id, (tool) => ({
          ...tool,
          output: event.output,
        })),
      };
    case 'tool_end':
      return {
        ...state,
        blocks: updateTool(state.blocks, event.id, (tool) => ({
          ...tool,
          done: true,
          isError: event.isError,
          output: event.output ?? tool.output,
          details: event.details ?? tool.details,
        })),
      };
    case 'error':
      // Keep the partial turn visible. The session refetch may replace it with
      // the persisted transcript, but until then the inline failure belongs
      // beside the text/thinking/tools that preceded it.
      return {
        ...state,
        active: false,
        thinkingActive: false,
        pendingAsk: undefined,
        pendingEnvRequest: undefined,
        terminalError: event.message,
      };
    default:
      return state;
  }
}

export type SendImage = { data: string; mimeType: string };

export type SendParams = {
  sessionId: string;
  userText: string;
  images?: SendImage[];
  attachmentIds?: string[];
  providerId: string;
  modelId: string;
};

export type RetryParams = {
  sessionId: string;
  expectedSessionUpdatedAt: string;
  providerId: string;
  modelId: string;
};

type StartParams = SendParams | (RetryParams & { retry: true });

export async function startAgentRunRequest(
  params: StartParams,
): Promise<{ runId: string }> {
  const res = await fetch('/api/agent/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }
  return (await res.json()) as { runId: string };
}

async function cancelAgentRunRequest(runId: string): Promise<void> {
  const res = await fetch(`/api/agent/runs/${runId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }
}

async function answerAgentRunRequest(
  runId: string,
  askId: string,
  answers: AskAnswer[],
): Promise<void> {
  const res = await fetch(`/api/agent/runs/${runId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ askId, answers }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Request failed (${res.status})`);
  }
}

async function submitAgentEnvRequest(
  runId: string,
  requestId: string,
  entries: EnvEntry[],
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/agent/runs/${runId}/env`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, entries }),
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export function useAgentStream(
  onDone: () => void,
  onTerminal: (errorMessage?: string) => boolean | Promise<boolean>,
  onDisconnect?: (runId: string) => void,
  onSessionChanged?: () => void,
  onConnected?: () => void,
) {
  const [state, setState] = useState<StreamState>(IDLE);
  const [envAnnouncement, setEnvAnnouncement] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const connectionGenerationRef = useRef(0);
  const promptBarrierRef = useRef<PromptBarrier | null>(null);
  const seedSnapshotRef = useRef<SeedSnapshot | null>(null);
  const startRequestIdRef = useRef(0);
  const terminalSourceRef = useRef<StreamSource | null>(null);
  const confirmedEnvTombstoneRef = useRef<ConfirmedEnvRequest | null>(null);
  const envSubmissionRef = useRef<EnvSubmission | null>(null);
  const pendingStartRef = useRef<{
    requestId: number;
    stopRequested: boolean;
  } | null>(null);
  const onDoneRef = useRef(onDone);
  const onTerminalRef = useRef(onTerminal);
  const onDisconnectRef = useRef(onDisconnect);
  const onSessionChangedRef = useRef(onSessionChanged);
  const onConnectedRef = useRef(onConnected);
  onDoneRef.current = onDone;
  onTerminalRef.current = onTerminal;
  onDisconnectRef.current = onDisconnect;
  onSessionChangedRef.current = onSessionChanged;
  onConnectedRef.current = onConnected;

  const isCurrentSource = useCallback(
    (source: StreamSource) =>
      connectionGenerationRef.current === source.generation &&
      runIdRef.current === source.runId,
    [],
  );

  const abortEnvSubmission = useCallback(() => {
    const submission = envSubmissionRef.current;
    if (!submission) return;
    envSubmissionRef.current = null;
    submission.controller.abort();
  }, []);

  /**
   * Reconcile persisted prompt metadata without touching the live SSE
   * connection. Session refetches are advisory snapshots: a changed non-null
   * prompt is authoritative, while a same-run null snapshot must not discard a
   * form (and its local input) that arrived through a newer stream event.
   */
  const syncSeed = useCallback(
    (runId: string, seed?: StreamSeed, seedRevision?: number) => {
      const previousSeedSnapshot = seedSnapshotRef.current;
      const sameSeedValue =
        previousSeedSnapshot?.runId === runId &&
        sameStreamSeed(previousSeedSnapshot.seed, seed);
      const sameSeedSnapshot =
        sameSeedValue && previousSeedSnapshot.revision === seedRevision;
      const sameRun = runIdRef.current === runId;
      const seedHasPrompt = Boolean(
        seed?.pendingAsk || seed?.pendingEnvRequest,
      );

      seedSnapshotRef.current = { runId, seed, revision: seedRevision };
      if (!sameRun) return;

      // A fresh canonical null snapshot proves that previously confirmed ids
      // are no longer pending. It may clear the replay tombstone, but it does
      // not unmount a live prompt that the snapshot may not have observed yet.
      if (seed && !seedHasPrompt && !sameSeedSnapshot) {
        confirmedEnvTombstoneRef.current = null;
      }

      // Only a semantically changed, non-null prompt can replace live prompt
      // state. A newer React Query timestamp alone is never authoritative.
      const authoritativeSeed = seedHasPrompt && !sameSeedValue;
      if (!authoritativeSeed) return;

      setEnvAnnouncement('');
      const seededEnv = seed?.pendingEnvRequest ?? undefined;
      const seedWasConfirmed = Boolean(
        seededEnv &&
        hasConfirmedEnvRequest(
          confirmedEnvTombstoneRef.current,
          runId,
          seededEnv.requestId,
        ),
      );
      const effectiveSeed: StreamSeed | undefined = seedWasConfirmed
        ? {
            pendingAsk: seed?.pendingAsk ?? null,
            pendingEnvRequest: null,
          }
        : seed;

      const submission = envSubmissionRef.current;
      if (
        submission?.runId === runId &&
        (Boolean(effectiveSeed?.pendingAsk) ||
          effectiveSeed?.pendingEnvRequest?.requestId !== submission.requestId)
      ) {
        abortEnvSubmission();
      }

      if (lastSeqRef.current === 0) {
        promptBarrierRef.current = barrierFromSeed(
          {
            runId,
            generation: connectionGenerationRef.current,
          },
          effectiveSeed,
        );
      }

      setState((current) => {
        if (current.runId !== runId) return current;
        const pendingEnvRequest = seedWasConfirmed
          ? current.pendingEnvRequest
          : seededEnv;
        return {
          ...current,
          pendingAsk: pendingEnvRequest
            ? undefined
            : (effectiveSeed?.pendingAsk ?? undefined),
          pendingEnvRequest,
        };
      });
    },
    [abortEnvSubmission],
  );

  const handleEvent = useCallback(
    (source: StreamSource, event: AgentStreamEvent) => {
      if (!isCurrentSource(source)) return;

      const barrier = promptBarrierRef.current;
      if (
        barrier &&
        barrier.runId === source.runId &&
        barrier.generation === source.generation &&
        isPromptEvent(event)
      ) {
        const matchesCurrentRequest =
          (barrier.kind === 'ask' &&
            event.type === 'ask' &&
            event.askId === barrier.requestId) ||
          (barrier.kind === 'env' &&
            event.type === 'env_request' &&
            event.requestId === barrier.requestId);
        if (!matchesCurrentRequest) return;
        promptBarrierRef.current = null;
      }

      switch (event.type) {
        case 'assistant_start':
        case 'text':
        case 'thinking':
        case 'ask':
        case 'ask_answered':
        case 'env_request':
        case 'env_stored':
        case 'tool_start':
        case 'tool_update':
        case 'tool_end': {
          const submission = envSubmissionRef.current;
          if (
            event.type === 'env_request' &&
            hasConfirmedEnvRequest(
              confirmedEnvTombstoneRef.current,
              source.runId,
              event.requestId,
            )
          ) {
            return;
          }
          if (
            submission &&
            ((event.type === 'ask' && submission.runId === source.runId) ||
              (event.type === 'env_request' &&
                submission.runId === source.runId &&
                submission.requestId !== event.requestId))
          ) {
            abortEnvSubmission();
          }
          if (event.type === 'env_stored') {
            const confirmationId = `${source.runId}:${event.requestId}`;
            confirmedEnvTombstoneRef.current = addConfirmedEnvRequest(
              confirmedEnvTombstoneRef.current,
              source.runId,
              event.requestId,
            );
            if (submission?.id === confirmationId) {
              abortEnvSubmission();
            }
            setEnvAnnouncement('Environment variables saved.');
            toast.dismiss(envFailureToastId(source.runId, event.requestId));
          } else if (event.type === 'env_request') {
            setEnvAnnouncement('');
          }
          setState((current) =>
            current.runId === source.runId
              ? reduceStreamState(current, event)
              : current,
          );
          break;
        }
        case 'done':
          abortEnvSubmission();
          terminalSourceRef.current = null;
          runIdRef.current = null;
          promptBarrierRef.current = null;
          setState(IDLE);
          onDoneRef.current();
          break;
        case 'cancelled':
          abortEnvSubmission();
          terminalSourceRef.current = null;
          runIdRef.current = null;
          promptBarrierRef.current = null;
          setState(IDLE);
          void Promise.resolve(onTerminalRef.current()).catch(() => {});
          break;
        case 'error': {
          abortEnvSubmission();
          terminalSourceRef.current = source;
          runIdRef.current = null;
          promptBarrierRef.current = null;
          setState((current) =>
            current.runId === source.runId
              ? reduceStreamState(current, event)
              : current,
          );
          void (async () => {
            try {
              const persisted = await onTerminalRef.current(event.message);
              // A later connection generation owns the UI now, including when
              // a retry reuses the same run id.
              const terminalSource = terminalSourceRef.current;
              if (
                terminalSource?.runId !== source.runId ||
                terminalSource.generation !== source.generation
              )
                return;
              if (!persisted) toast.error(event.message);
              terminalSourceRef.current = null;
              setState((current) =>
                current.runId === source.runId ? IDLE : current,
              );
            } catch {
              // Refetch failed: keep the live partial turn + inline error so the
              // failure does not disappear merely because recovery is offline.
            }
          })();
          break;
        }
        default:
          break;
      }
    },
    [abortEnvSubmission, isCurrentSource],
  );

  /**
   * Open an SSE subscription for a run and return a disconnect callback.
   *
   * This is intentionally synchronous so a single `useEffect` can own the whole
   * connection lifecycle: the caller wires the returned callback as the effect's
   * cleanup. That keeps connect/disconnect symmetric, so when React tears down
   * and re-runs passive effects (Suspense hide/show, remounts) the stream is
   * aborted *and* re-established instead of being left dangling.
   */
  const connect = useCallback(
    (runId: string) => {
      const sameRun = runIdRef.current === runId;
      abortRef.current?.abort();
      terminalSourceRef.current = null;
      const ac = new AbortController();
      abortRef.current = ac;
      const generation = connectionGenerationRef.current + 1;
      connectionGenerationRef.current = generation;
      const source = { runId, generation };
      if (!sameRun) {
        abortEnvSubmission();
        confirmedEnvTombstoneRef.current = null;
        setEnvAnnouncement('');
        lastSeqRef.current = 0;
      }
      runIdRef.current = runId;
      const after = lastSeqRef.current;
      const seed =
        seedSnapshotRef.current?.runId === runId
          ? seedSnapshotRef.current.seed
          : undefined;
      const seededEnv = seed?.pendingEnvRequest ?? undefined;
      const seedWasConfirmed = Boolean(
        seededEnv &&
        hasConfirmedEnvRequest(
          confirmedEnvTombstoneRef.current,
          runId,
          seededEnv.requestId,
        ),
      );
      const effectiveSeed: StreamSeed | undefined = seedWasConfirmed
        ? {
            pendingAsk: seed?.pendingAsk ?? null,
            pendingEnvRequest: null,
          }
        : seed;
      promptBarrierRef.current =
        after === 0 ? barrierFromSeed(source, effectiveSeed) : null;
      setState((current) => {
        if (!sameRun || current.runId !== runId) {
          return stateFromSeed(runId, effectiveSeed);
        }
        return { ...current, active: true };
      });

      const isCurrentConnection = () =>
        !ac.signal.aborted && isCurrentSource(source);

      const read = async () => {
        try {
          const res = await fetch(
            `/api/agent/runs/${runId}/events?after=${after}`,
            { signal: ac.signal },
          );
          if (!isCurrentConnection()) return;
          if (!res.ok || !res.body) {
            throw new Error(`Request failed (${res.status})`);
          }
          // A healthy connection: let the caller reset any reconnect backoff.
          onConnectedRef.current?.();

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (!isCurrentConnection()) return;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const line = chunk.trim();
              if (!line.startsWith('data:')) continue;
              const json = line.slice(5).trim();
              if (!json) continue;
              const envelope = JSON.parse(json) as AgentRunStreamEvent;
              if (!isCurrentConnection()) return;
              if (envelope.seq <= lastSeqRef.current) continue;
              lastSeqRef.current = envelope.seq;
              handleEvent(source, envelope.event);
            }
          }
          if (isCurrentConnection()) {
            onSessionChangedRef.current?.();
            onDisconnectRef.current?.(runId);
          }
        } catch {
          // A dropped/failed stream isn't fatal: the run keeps executing on the
          // server. Reconnect silently (the caller backs off and only surfaces a
          // toast after repeated failures) instead of alarming on every blip.
          if (isCurrentConnection()) {
            onSessionChangedRef.current?.();
            onDisconnectRef.current?.(runId);
          }
        }
      };

      void read();

      return () => {
        ac.abort();
      };
    },
    [abortEnvSubmission, handleEvent, isCurrentSource],
  );

  const reset = useCallback(() => {
    connectionGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    abortEnvSubmission();
    runIdRef.current = null;
    lastSeqRef.current = 0;
    promptBarrierRef.current = null;
    seedSnapshotRef.current = null;
    terminalSourceRef.current = null;
    confirmedEnvTombstoneRef.current = null;
    setState(IDLE);
  }, [abortEnvSubmission]);

  useEffect(
    () => () => {
      connectionGenerationRef.current += 1;
      abortRef.current?.abort();
      envSubmissionRef.current?.controller.abort();
    },
    [],
  );

  const start = useCallback(async (params: StartParams) => {
    terminalSourceRef.current = null;
    setEnvAnnouncement('');
    const requestId = startRequestIdRef.current + 1;
    startRequestIdRef.current = requestId;
    pendingStartRef.current = { requestId, stopRequested: false };

    try {
      setState({ ...IDLE, active: true });
      const { runId } = await startAgentRunRequest(params);
      const pending = pendingStartRef.current;
      const shouldCancel =
        !pending || pending.requestId !== requestId || pending.stopRequested;

      if (pending?.requestId === requestId) {
        pendingStartRef.current = null;
      }

      if (shouldCancel) {
        try {
          await cancelAgentRunRequest(runId);
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : 'Could not stop.',
          );
        } finally {
          onSessionChangedRef.current?.();
        }
        return null;
      }

      // The run is live; the caller surfaces it via `activeRun` and the
      // connection effect subscribes. We deliberately do not connect here so
      // a single effect owns the stream's lifecycle.
      return runId;
    } catch (error) {
      const pending = pendingStartRef.current;
      const stopRequested =
        pending?.requestId === requestId && pending.stopRequested;
      if (pending?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      if (!stopRequested) {
        toast.error(error instanceof Error ? error.message : 'Stream failed');
      }
      setState(IDLE);
      return null;
    }
  }, []);

  const send = useCallback((params: SendParams) => start(params), [start]);
  const retry = useCallback(
    (params: RetryParams) => start({ ...params, retry: true }),
    [start],
  );

  const answer = useCallback(async (askId: string, answers: AskAnswer[]) => {
    const runId = runIdRef.current;
    if (!runId) return;
    // Optimistically hide the form for snappy feedback, but remember it: if the
    // POST fails the run is still blocked, so we must restore the form or the
    // chat is stuck with no way to unblock it.
    let previousAsk: PendingAsk | undefined;
    setState((p) => {
      if (p.pendingAsk?.askId !== askId) return p;
      previousAsk = p.pendingAsk;
      return { ...p, pendingAsk: undefined };
    });
    try {
      await answerAgentRunRequest(runId, askId, answers);
    } catch {
      toast.error('Could not submit your answer. Try again.');
      // Restore the same ask so the user can retry — but only if this run is
      // still active and nothing newer (a fresh ask) has taken its place.
      setState((p) =>
        previousAsk && p.active && !p.pendingAsk && runIdRef.current === runId
          ? { ...p, pendingAsk: previousAsk }
          : p,
      );
    }
  }, []);

  const submitEnv = useCallback(
    async (requestId: string, entries: EnvEntry[]): Promise<boolean> => {
      const runId = runIdRef.current;
      if (!runId) return false;
      const submissionId = `${runId}:${requestId}`;
      if (envSubmissionRef.current) return false;
      const submission: EnvSubmission = {
        id: submissionId,
        runId,
        requestId,
        controller: new AbortController(),
        timedOut: false,
      };
      envSubmissionRef.current = submission;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            submission.timedOut = true;
            submission.controller.abort();
            reject(new Error('Environment submission timed out'));
          }, ENV_SUBMISSION_TIMEOUT_MS);
        });
        await Promise.race([
          submitAgentEnvRequest(
            runId,
            requestId,
            entries,
            submission.controller.signal,
          ),
          timeoutPromise,
        ]);
        if (
          envSubmissionRef.current !== submission ||
          runIdRef.current !== runId
        ) {
          return false;
        }
        setState((current) =>
          current.runId === runId &&
          current.pendingEnvRequest?.requestId === requestId
            ? { ...current, pendingEnvRequest: undefined }
            : current,
        );
        confirmedEnvTombstoneRef.current = addConfirmedEnvRequest(
          confirmedEnvTombstoneRef.current,
          runId,
          requestId,
        );
        setEnvAnnouncement('Environment variables saved.');
        toast.dismiss(envFailureToastId(runId, requestId));
        return true;
      } catch (error) {
        if (
          hasConfirmedEnvRequest(
            confirmedEnvTombstoneRef.current,
            runId,
            requestId,
          )
        ) {
          return true;
        }
        const stale =
          envSubmissionRef.current !== submission || runIdRef.current !== runId;
        const aborted =
          error instanceof DOMException && error.name === 'AbortError';
        if (stale || (aborted && !submission.timedOut)) return false;
        await new Promise((resolve) =>
          setTimeout(resolve, ENV_CONFIRMATION_GRACE_MS),
        );
        const confirmed = hasConfirmedEnvRequest(
          confirmedEnvTombstoneRef.current,
          runId,
          requestId,
        );
        if (
          confirmed ||
          envSubmissionRef.current !== submission ||
          runIdRef.current !== runId
        ) {
          return confirmed;
        }
        toast.error(
          'Could not confirm the environment variables were saved. Try again.',
          { id: envFailureToastId(runId, requestId) },
        );
        return false;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (envSubmissionRef.current === submission) {
          envSubmissionRef.current = null;
        }
      }
    },
    [],
  );

  const stop = useCallback(
    async (runIdOverride?: string) => {
      if (pendingStartRef.current) {
        pendingStartRef.current.stopRequested = true;
      }
      const runId = runIdOverride ?? runIdRef.current;
      reset();
      if (!runId) return;
      try {
        await cancelAgentRunRequest(runId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not stop.');
      }
    },
    [reset],
  );

  return {
    state,
    send,
    retry,
    connect,
    syncSeed,
    reset,
    stop,
    answer,
    submitEnv,
    envAnnouncement,
  };
}
