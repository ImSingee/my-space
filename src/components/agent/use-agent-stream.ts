import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AgentStreamEvent, AskAnswer, AskQuestion } from '~agent/events';
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
  text: string;
  thinking: string;
  /** True while thinking deltas are streaming, before text/tools take over. */
  thinkingActive: boolean;
  tools: StreamTool[];
  pendingAsk?: PendingAsk;
};

const IDLE: StreamState = {
  active: false,
  text: '',
  thinking: '',
  thinkingActive: false,
  tools: [],
  pendingAsk: undefined,
};

type SendImage = { data: string; mimeType: string };

type SendParams = {
  sessionId: string;
  userText: string;
  images?: SendImage[];
  providerId?: string | null;
  modelId?: string | null;
};

export function useAgentStream(
  onDone: (messages: ChatMessage[], title: string) => void,
) {
  const [state, setState] = useState<StreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const handleEvent = useCallback((event: AgentStreamEvent) => {
    switch (event.type) {
      case 'text':
        setState((p) => ({
          ...p,
          text: p.text + (event.delta ?? ''),
          thinkingActive: false,
        }));
        break;
      case 'thinking':
        setState((p) => ({
          ...p,
          thinking: p.thinking + (event.delta ?? ''),
          thinkingActive: true,
        }));
        break;
      case 'ask':
        setState((p) => ({
          ...p,
          thinkingActive: false,
          pendingAsk: { askId: event.askId, questions: event.questions },
        }));
        break;
      case 'tool_start':
        setState((p) => ({
          ...p,
          thinkingActive: false,
          tools: [
            ...p.tools,
            {
              id: event.id,
              name: event.name,
              args: (event.args ?? undefined) as
                | Record<string, unknown>
                | undefined,
              done: false,
            },
          ],
        }));
        break;
      case 'tool_update':
        setState((p) => ({
          ...p,
          tools: p.tools.map((t) =>
            t.id === event.id ? { ...t, output: event.output } : t,
          ),
        }));
        break;
      case 'tool_end':
        setState((p) => ({
          ...p,
          tools: p.tools.map((t) =>
            t.id === event.id
              ? {
                  ...t,
                  done: true,
                  isError: event.isError,
                  output: event.output || t.output,
                }
              : t,
          ),
        }));
        break;
      case 'done':
        setState(IDLE);
        onDoneRef.current(
          event.messages as unknown as ChatMessage[],
          event.title,
        );
        break;
      case 'error':
        toast.error(event.message);
        setState(IDLE);
        break;
      default:
        break;
    }
  }, []);

  const send = useCallback(
    async (params: SendParams) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState({ ...IDLE, active: true });

      try {
        const res = await fetch('/api/agent/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
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
            if (json) handleEvent(JSON.parse(json) as AgentStreamEvent);
          }
        }
      } catch (error) {
        if (!ac.signal.aborted) {
          toast.error(error instanceof Error ? error.message : 'Stream failed');
        }
        setState(IDLE);
      }
    },
    [handleEvent],
  );

  const answer = useCallback(async (askId: string, answers: AskAnswer[]) => {
    setState((p) =>
      p.pendingAsk?.askId === askId ? { ...p, pendingAsk: undefined } : p,
    );
    try {
      const res = await fetch('/api/agent/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askId, answers }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    } catch {
      toast.error('Could not submit your answer. Try again.');
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  return { state, send, stop, answer };
}
