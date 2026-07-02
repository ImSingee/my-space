import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
} from '~agent/events';

export type StreamTool = {
  id: string;
  name: string;
  /** Display label sent by the server on tool_start (avoids raw snake_case). */
  label?: string;
  args?: Record<string, unknown>;
  done: boolean;
  isError?: boolean;
  /** Live (while running) or final (on completion) tool output text. */
  output?: string;
};

export type PendingAsk = {
  askId: string;
  questions: AskQuestion[];
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
};

const IDLE: StreamState = {
  active: false,
  runId: undefined,
  blocks: [],
  thinkingActive: false,
  pendingAsk: undefined,
};

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
      };
    case 'ask_answered':
      return state.pendingAsk?.askId === event.askId
        ? { ...state, pendingAsk: undefined }
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
              args: (event.args ?? undefined) as
                | Record<string, unknown>
                | undefined,
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
          output: event.output || tool.output,
        })),
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
  providerId?: string | null;
  modelId?: string | null;
};

export async function startAgentRunRequest(
  params: SendParams,
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

export function useAgentStream(
  onDone: () => void,
  onTerminal?: () => void,
  onDisconnect?: (runId: string) => void,
  onSessionChanged?: () => void,
  onConnected?: () => void,
) {
  const [state, setState] = useState<StreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const startRequestIdRef = useRef(0);
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

  const handleEvent = useCallback((event: AgentStreamEvent) => {
    switch (event.type) {
      case 'assistant_start':
      case 'text':
      case 'thinking':
      case 'ask':
      case 'ask_answered':
      case 'tool_start':
      case 'tool_update':
      case 'tool_end':
        setState((p) => reduceStreamState(p, event));
        break;
      case 'done':
        runIdRef.current = null;
        setState(IDLE);
        onDoneRef.current();
        break;
      case 'cancelled':
        runIdRef.current = null;
        setState(IDLE);
        onTerminalRef.current?.();
        break;
      case 'error':
        runIdRef.current = null;
        toast.error(event.message);
        setState(IDLE);
        onTerminalRef.current?.();
        break;
      default:
        break;
    }
  }, []);

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
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      runIdRef.current = runId;
      lastSeqRef.current = 0;
      setState({ ...IDLE, active: true, runId });

      const read = async () => {
        try {
          const res = await fetch(`/api/agent/runs/${runId}/events?after=0`, {
            signal: ac.signal,
          });
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
              lastSeqRef.current = envelope.seq;
              handleEvent(envelope.event);
            }
          }
          if (!ac.signal.aborted && runIdRef.current === runId) {
            runIdRef.current = null;
            setState(IDLE);
            onDisconnectRef.current?.(runId);
          }
        } catch {
          // A dropped/failed stream isn't fatal: the run keeps executing on the
          // server. Reconnect silently (the caller backs off and only surfaces a
          // toast after repeated failures) instead of alarming on every blip.
          if (!ac.signal.aborted && runIdRef.current === runId) {
            runIdRef.current = null;
            setState(IDLE);
            onDisconnectRef.current?.(runId);
          }
        }
      };

      void read();

      return () => {
        ac.abort();
      };
    },
    [handleEvent],
  );

  const send = useCallback(async (params: SendParams) => {
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

  const stop = useCallback(async (runIdOverride?: string) => {
    if (pendingStartRef.current) {
      pendingStartRef.current.stopRequested = true;
    }
    const runId = runIdOverride ?? runIdRef.current;
    abortRef.current?.abort();
    runIdRef.current = null;
    setState(IDLE);
    if (!runId) return;
    try {
      await cancelAgentRunRequest(runId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stop.');
    }
  }, []);

  return { state, send, connect, stop, answer };
}
