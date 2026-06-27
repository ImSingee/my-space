import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
} from '~agent/events';
import type { ChatMessage } from './types';

export type StreamTool = {
  id: string;
  name: string;
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

export type StreamState = {
  active: boolean;
  runId?: string;
  text: string;
  thinking: string;
  /** True while thinking deltas are streaming, before text/tools take over. */
  thinkingActive: boolean;
  tools: StreamTool[];
  pendingAsk?: PendingAsk;
};

const IDLE: StreamState = {
  active: false,
  runId: undefined,
  text: '',
  thinking: '',
  thinkingActive: false,
  tools: [],
  pendingAsk: undefined,
};

export function reduceStreamState(
  state: StreamState,
  event: AgentStreamEvent,
): StreamState {
  switch (event.type) {
    case 'text':
      return {
        ...state,
        text: state.text + (event.delta ?? ''),
        thinkingActive: false,
      };
    case 'thinking':
      return {
        ...state,
        thinking: state.thinking + (event.delta ?? ''),
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
        tools: [
          ...state.tools,
          {
            id: event.id,
            name: event.name,
            args: (event.args ?? undefined) as
              | Record<string, unknown>
              | undefined,
            done: false,
          },
        ],
      };
    case 'tool_update':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.id === event.id ? { ...t, output: event.output } : t,
        ),
      };
    case 'tool_end':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.id === event.id
            ? {
                ...t,
                done: true,
                isError: event.isError,
                output: event.output || t.output,
              }
            : t,
        ),
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
  onDone: (messages: ChatMessage[], title: string) => void,
  onTerminal?: () => void,
  onDisconnect?: (runId: string) => void,
  onSessionChanged?: () => void,
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
  onDoneRef.current = onDone;
  onTerminalRef.current = onTerminal;
  onDisconnectRef.current = onDisconnect;
  onSessionChangedRef.current = onSessionChanged;

  const handleEvent = useCallback((event: AgentStreamEvent) => {
    switch (event.type) {
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
        onDoneRef.current(
          event.messages as unknown as ChatMessage[],
          event.title,
        );
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

  const connect = useCallback(
    async (runId: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      runIdRef.current = runId;
      lastSeqRef.current = 0;
      setState({ ...IDLE, active: true, runId });

      try {
        const res = await fetch(`/api/agent/runs/${runId}/events?after=0`, {
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Request failed (${res.status})`);
        }

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
      } catch (error) {
        if (!ac.signal.aborted && runIdRef.current === runId) {
          runIdRef.current = null;
          toast.error(error instanceof Error ? error.message : 'Stream failed');
          setState(IDLE);
          onDisconnectRef.current?.(runId);
        }
      }
    },
    [handleEvent],
  );

  const send = useCallback(
    async (params: SendParams) => {
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

        void connect(runId);
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
    },
    [connect],
  );

  const answer = useCallback(async (askId: string, answers: AskAnswer[]) => {
    const runId = runIdRef.current;
    if (!runId) return;
    setState((p) =>
      p.pendingAsk?.askId === askId ? { ...p, pendingAsk: undefined } : p,
    );
    try {
      await answerAgentRunRequest(runId, askId, answers);
    } catch {
      toast.error('Could not submit your answer. Try again.');
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

  useEffect(
    () => () => {
      if (pendingStartRef.current) {
        pendingStartRef.current.stopRequested = true;
      }
      abortRef.current?.abort();
    },
    [],
  );

  return { state, send, connect, stop, answer };
}
