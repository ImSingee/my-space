import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AgentStreamEvent } from '~agent/events';
import type { ChatMessage } from './types';

export type StreamTool = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  done: boolean;
  isError?: boolean;
};

export type StreamState = {
  active: boolean;
  text: string;
  thinking: string;
  tools: StreamTool[];
};

const IDLE: StreamState = {
  active: false,
  text: '',
  thinking: '',
  tools: [],
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
        setState((p) => ({ ...p, text: p.text + (event.delta ?? '') }));
        break;
      case 'thinking':
        setState((p) => ({ ...p, thinking: p.thinking + (event.delta ?? '') }));
        break;
      case 'tool_start':
        setState((p) => ({
          ...p,
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
      case 'tool_end':
        setState((p) => ({
          ...p,
          tools: p.tools.map((t) =>
            t.id === event.id
              ? { ...t, done: true, isError: event.isError }
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

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  return { state, send, stop };
}
