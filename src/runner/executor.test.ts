import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '~agent/platform-client';
import type { RunnerMessage, RunStartPayload } from '~agent/protocol';
import type { RunAgentTurnResult } from '~agent/runtime';

vi.mock('~agent/runtime', () => {
  type Runtime = typeof import('~agent/runtime');
  return { runAgentTurn: vi.fn<Runtime['runAgentTurn']>() };
});

const { runAgentTurn } = await import('~agent/runtime');
const { RunnerExecutor } = await import('./executor');

const stubPlatform = new Proxy({} as PlatformClient, {
  get(_target, prop) {
    return () => {
      throw new Error(`Unexpected PlatformClient.${String(prop)} call.`);
    };
  },
});

const payload: RunStartPayload = {
  runId: 'run-1',
  sessionId: 'session-1',
  userText: 'hello',
  images: [],
  attachments: [],
  priorMessages: [],
  model: {
    providerId: 'provider-1',
    providerName: 'Test Provider',
    apiType: 'openai-responses',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: {
      id: 'model-1',
      name: 'Test Model',
      reasoning: false,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  },
};

type FinishedMessage = Extract<RunnerMessage, { type: 'run.finished' }>;

function setupExecutor() {
  const sent: RunnerMessage[] = [];
  const executor = new RunnerExecutor({
    platform: stubPlatform,
    send: (message) => {
      sent.push(message);
      return true;
    },
  });
  const finished = () =>
    sent.find(
      (message): message is FinishedMessage => message.type === 'run.finished',
    );
  return { executor, finished };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RunnerExecutor terminal outcomes', () => {
  it('reports a runtime error as failed with the transcript', async () => {
    const messages: RunAgentTurnResult['messages'] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial reply' }],
        stopReason: 'error',
      },
    ];
    vi.mocked(runAgentTurn).mockResolvedValueOnce({
      messages,
      error: 'OpenAI API error (402): no body',
    });
    const { executor, finished } = setupExecutor();

    expect(executor.start(payload)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(finished()).toBeDefined());

    expect(finished()).toEqual({
      type: 'run.finished',
      runId: payload.runId,
      status: 'failed',
      error: 'OpenAI API error (402): no body',
      messages,
    });
    executor.ackFinish(payload.runId);
  });

  it('keeps cancellation authoritative and preserves partial messages', async () => {
    const messages: RunAgentTurnResult['messages'] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial reply' }],
        stopReason: 'aborted',
      },
    ];
    let resolveRun!: (result: RunAgentTurnResult) => void;
    const result = new Promise<RunAgentTurnResult>((resolve) => {
      resolveRun = resolve;
    });
    let signal: AbortSignal | undefined;
    vi.mocked(runAgentTurn).mockImplementationOnce((options) => {
      signal = options.signal;
      return result;
    });
    const { executor, finished } = setupExecutor();

    expect(executor.start(payload)).toEqual({ accepted: true });
    executor.cancel(payload.runId);
    expect(signal?.aborted).toBe(true);
    resolveRun({
      messages,
      error: 'Request was aborted',
    });
    await vi.waitFor(() => expect(finished()).toBeDefined());

    expect(finished()).toEqual({
      type: 'run.finished',
      runId: payload.runId,
      status: 'cancelled',
      messages,
    });
    executor.ackFinish(payload.runId);
  });

  it('aborts and settles every run before a session workspace is removed', async () => {
    vi.mocked(runAgentTurn).mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => resolve({ messages: [], error: 'aborted for cleanup' }),
            { once: true },
          );
        }),
    );
    const { executor } = setupExecutor();
    const other = {
      ...payload,
      runId: 'run-other',
      sessionId: 'session-other',
    };

    expect(executor.start(payload)).toEqual({ accepted: true });
    expect(executor.start(other)).toEqual({ accepted: true });
    await executor.abortSession(payload.sessionId);

    expect(executor.activeRunIds()).toEqual(['run-other']);
    executor.abortStale(other.runId);
    await vi.waitFor(() => expect(executor.activeRunIds()).toEqual([]));
  });
});
