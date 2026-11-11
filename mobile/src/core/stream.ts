import { MobileError, throwIfAborted } from './security';
import type {
  AgentStreamEvent,
  JsonValue,
  PendingAsk,
  PendingEnv,
  RunStreamEvent,
} from './types';

export type ToolState = {
  id: string;
  name: string;
  label?: string;
  args?: JsonValue;
  details?: JsonValue;
  output?: string;
  summary?: string;
  done: boolean;
  isError?: boolean;
};
export type StreamBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string };
export type StreamState = {
  lastSeq: number;
  text: string;
  thinking: string;
  tools: ToolState[];
  blocks: StreamBlock[];
  messageStart: number;
  pendingAsk: PendingAsk | null;
  pendingEnv: PendingEnv | null;
  terminal: 'done' | 'cancelled' | 'error' | null;
  error: string | null;
};

/** Keep this whole state in memory across reconnects; on cold start replay from 0. */
export function initialStreamState(): StreamState {
  return {
    lastSeq: 0,
    text: '',
    thinking: '',
    tools: [],
    blocks: [],
    messageStart: 0,
    pendingAsk: null,
    pendingEnv: null,
    terminal: null,
    error: null,
  };
}

function appendBlock(
  state: StreamState,
  kind: 'text' | 'thinking',
  delta: string,
): StreamBlock[] {
  const blocks = [...state.blocks];
  const last = blocks.at(-1);
  if (last?.kind === kind && blocks.length > state.messageStart) {
    blocks[blocks.length - 1] = { kind, text: last.text + delta };
  } else blocks.push({ kind, text: delta });
  return blocks;
}

export function reduceStreamEvent(
  state: StreamState,
  packet: RunStreamEvent,
): StreamState {
  if (packet.seq <= state.lastSeq || state.terminal) return state;
  const next = { ...state, lastSeq: packet.seq };
  const event = packet.event;
  switch (event.type) {
    case 'assistant_start':
      return { ...next, messageStart: state.blocks.length };
    case 'text':
      return {
        ...next,
        text: state.text + event.delta,
        blocks: appendBlock(state, 'text', event.delta),
      };
    case 'thinking':
      return {
        ...next,
        thinking: state.thinking + event.delta,
        blocks: appendBlock(state, 'thinking', event.delta),
      };
    case 'ask':
      return {
        ...next,
        pendingAsk: { askId: event.askId, questions: event.questions },
        pendingEnv: null,
      };
    case 'ask_answered':
      return {
        ...next,
        pendingAsk:
          state.pendingAsk?.askId === event.askId ? null : state.pendingAsk,
      };
    case 'env_request':
      return {
        ...next,
        pendingEnv: {
          requestId: event.requestId,
          reason: event.reason,
          variables: event.variables,
        },
        pendingAsk: null,
      };
    case 'env_stored':
      return {
        ...next,
        pendingEnv:
          state.pendingEnv?.requestId === event.requestId
            ? null
            : state.pendingEnv,
      };
    case 'tool_start':
      return {
        ...next,
        tools: [
          ...state.tools.filter((tool) => tool.id !== event.id),
          { ...event, done: false },
        ],
        blocks: state.tools.some((tool) => tool.id === event.id)
          ? state.blocks
          : [...state.blocks, { kind: 'tool', id: event.id }],
      };
    case 'tool_update':
      return {
        ...next,
        tools: state.tools.map((tool) =>
          tool.id === event.id ? { ...tool, output: event.output } : tool,
        ),
      };
    case 'tool_end':
      return {
        ...next,
        tools: state.tools.map((tool) =>
          tool.id === event.id
            ? {
                ...tool,
                done: true,
                isError: event.isError,
                output: event.output ?? tool.output,
                details: event.details ?? tool.details,
                summary: event.summary,
              }
            : tool,
        ),
      };
    case 'done':
    case 'cancelled':
    case 'error':
      return {
        ...next,
        terminal: event.type,
        error: event.type === 'error' ? event.message : null,
        pendingAsk: null,
        pendingEnv: null,
      };
    default:
      return next;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function question(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.allowMultiple === 'boolean' &&
    Array.isArray(value.options) &&
    value.options.every(
      (option) =>
        record(option) &&
        typeof option.id === 'string' &&
        typeof option.label === 'string',
    )
  );
}
function validEvent(value: unknown): value is AgentStreamEvent {
  if (!record(value)) return false;
  switch (value.type) {
    case 'assistant_start':
    case 'turn_end':
    case 'done':
    case 'cancelled':
      return true;
    case 'text':
    case 'thinking':
      return typeof value.delta === 'string';
    case 'error':
      return typeof value.message === 'string';
    case 'ask':
      return (
        typeof value.askId === 'string' &&
        Array.isArray(value.questions) &&
        value.questions.every(question)
      );
    case 'ask_answered':
      return typeof value.askId === 'string';
    case 'env_request':
      return (
        typeof value.requestId === 'string' &&
        typeof value.reason === 'string' &&
        Array.isArray(value.variables) &&
        value.variables.every(
          (item) =>
            record(item) &&
            typeof item.key === 'string' &&
            typeof item.description === 'string' &&
            typeof item.secret === 'boolean',
        )
      );
    case 'env_stored':
      return (
        typeof value.requestId === 'string' &&
        Array.isArray(value.variables) &&
        value.variables.every(
          (item) =>
            record(item) &&
            typeof item.key === 'string' &&
            typeof item.secret === 'boolean',
        )
      );
    case 'tool_start':
      return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        'args' in value
      );
    case 'tool_update':
      return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.output === 'string'
      );
    case 'tool_end':
      return (
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        typeof value.isError === 'boolean' &&
        (value.output === undefined || typeof value.output === 'string')
      );
    default:
      return false;
  }
}
export function parseRunStreamEvent(input: string): RunStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new MobileError(
      'invalid_stream',
      'The instance sent an invalid stream event.',
    );
  }
  if (
    !record(value) ||
    !Number.isSafeInteger(value.seq) ||
    Number(value.seq) < 1 ||
    !validEvent(value.event)
  ) {
    throw new MobileError(
      'invalid_stream',
      'The instance sent an invalid stream event.',
    );
  }
  return { seq: Number(value.seq), event: value.event };
}

/** Incremental SSE parsing: comments, CR/LF/CRLF, multi-line data, split UTF-8. */
export class SseParser {
  private line = '';
  private data: string[] = [];
  private dataLength = 0;
  private previousCR = false;
  private decoder = new TextDecoder();
  constructor(
    private readonly emit: (data: string) => void,
    private readonly maxEventSize = 2 * 1024 * 1024,
  ) {}

  push(bytes: Uint8Array): void {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }
  finish(): void {
    this.consume(this.decoder.decode());
    // SSE only dispatches complete, blank-line-terminated events. A torn tail
    // is discarded and recovered by replay from the last delivered sequence.
  }
  private consume(text: string): void {
    for (const char of text) {
      if (char === '\n' && this.previousCR) {
        this.previousCR = false;
        continue;
      }
      this.previousCR = char === '\r';
      if (char === '\r' || char === '\n') {
        this.consumeLine(this.line);
        this.line = '';
      } else this.line += char;
      if (this.line.length + this.dataLength > this.maxEventSize) {
        throw new MobileError(
          'stream_too_large',
          'The instance sent an oversized stream event.',
        );
      }
    }
  }
  private consumeLine(line: string): void {
    if (line === '') {
      if (this.data.length) this.emit(this.data.join('\n'));
      this.data = [];
      this.dataLength = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.data.push(value);
      this.dataLength += value.length + 1;
    }
  }
}

export type StreamOptions = {
  after?: number;
  signal?: AbortSignal;
  /** Server heartbeats arrive every 20 seconds, even while a run is blocked. */
  idleTimeoutMs?: number;
  /** Bounds initial connection independently from the live body watchdog. */
  headerTimeoutMs?: number;
  onEvent: (packet: RunStreamEvent) => void;
};
export type StreamResult = {
  reason: 'terminal' | 'disconnected';
  lastSeq: number;
};

/** One connection only. The caller controls backoff/foreground reconnects. */
export async function streamRunEvents(
  response: Response,
  options: StreamOptions,
): Promise<StreamResult> {
  if (options.signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throwIfAborted(options.signal);
  }
  if (
    !response.ok ||
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('text/event-stream') ||
    !response.body
  ) {
    throw new MobileError(
      'invalid_stream',
      'The instance did not return an event stream.',
      response.status,
    );
  }
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new MobileError(
      'invalid_timeout',
      'Stream idle timeout must be positive.',
    );
  }
  let lastSeq = options.after ?? 0;
  let terminal = false;
  let lastActivity = Date.now();
  const reader = response.body.getReader();
  let cancellationRequested = false;
  const cancelReader = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    // A broken native transport can leave cancel() pending too. Request cleanup
    // without making foreground reconnect or explicit cancellation wait on it.
    void reader.cancel().catch(() => undefined);
  };
  const readNext = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const interrupt = (error: MobileError) => {
        if (settled) return;
        settled = true;
        cleanup();
        cancelReader();
        reject(error);
      };
      const onAbort = () =>
        interrupt(new MobileError('cancelled', 'Cancelled.'));
      const timer = setTimeout(
        () =>
          interrupt(
            new MobileError(
              'stream_timeout',
              'The connection stopped responding. Reconnect to resume this run.',
            ),
          ),
        Math.max(0, idleTimeoutMs - (Date.now() - lastActivity)),
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      reader.read().then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  const parser = new SseParser((data) => {
    if (terminal) return;
    const packet = parseRunStreamEvent(data);
    if (packet.seq <= lastSeq) return;
    if (packet.seq !== lastSeq + 1) {
      throw new MobileError(
        'stream_gap',
        'The event stream has a gap. Reload the session and replay this run.',
      );
    }
    options.onEvent(packet);
    lastSeq = packet.seq;
    terminal = ['done', 'cancelled', 'error'].includes(packet.event.type);
  });
  try {
    throwIfAborted(options.signal);
    while (!terminal) {
      const { done, value } = await readNext();
      throwIfAborted(options.signal);
      if (done) {
        parser.finish();
        break;
      }
      if (value?.byteLength) {
        lastActivity = Date.now();
        parser.push(value);
      }
    }
    return { reason: terminal ? 'terminal' : 'disconnected', lastSeq };
  } catch (error) {
    throwIfAborted(options.signal);
    if (error instanceof MobileError) throw error;
    throw new MobileError(
      'stream_disconnected',
      'The connection was interrupted. Reconnect to resume this run.',
    );
  } finally {
    cancelReader();
    reader.releaseLock();
  }
}
