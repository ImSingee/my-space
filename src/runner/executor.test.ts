import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '~agent/platform-client';
import type { RunnerMessage, RunStartPayload } from '~agent/protocol';
import type { RunAgentTurnResult } from '~agent/runtime';

vi.mock('~agent/runtime', () => {
  type Runtime = typeof import('~agent/runtime');
  return { runAgentTurn: vi.fn<Runtime['runAgentTurn']>() };
});

vi.mock('~agent/env-file', () => ({
  writeEnvFile: vi.fn<(typeof import('~agent/env-file'))['writeEnvFile']>(
    async () => {},
  ),
}));

vi.mock('~agent/shell-sandbox', () => ({
  prepareAgentSessionSandbox: vi.fn<
    (typeof import('~agent/shell-sandbox'))['prepareAgentSessionSandbox']
  >(() => undefined),
}));

const { runAgentTurn } = await import('~agent/runtime');
const { writeEnvFile } = await import('~agent/env-file');
const { prepareAgentSessionSandbox } = await import('~agent/shell-sandbox');
const { RunnerExecutor } = await import('./executor');

const APP_URL = 'https://hatch.example.test';
const TAVILY_API_KEY = 'tvly-test-key';

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
  composerContent: [],
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

function setupExecutor(tavilyApiKey?: string) {
  const sent: RunnerMessage[] = [];
  const executor = new RunnerExecutor({
    appUrl: APP_URL,
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
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
  return { executor, finished, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareAgentSessionSandbox).mockReturnValue(undefined);
  vi.mocked(writeEnvFile).mockResolvedValue(undefined);
});

describe('RunnerExecutor environment delivery', () => {
  it('writes every value but reveals only final non-secret entries', async () => {
    const canary = 'runner-canary-never-crosses-outbound';
    const visible = 'account-1';
    vi.mocked(runAgentTurn).mockImplementationOnce(async (options) => {
      const stored = await options.requestEnv?.('Call the private service.', [
        {
          key: 'SERVICE_TOKEN',
          description: 'Read-only token.',
          secret: false,
        },
        {
          key: 'ACCOUNT_ID',
          description: 'Public account id.',
          secret: true,
        },
      ]);
      return {
        messages: [{ role: 'assistant', content: JSON.stringify(stored) }],
      };
    });
    const { executor, sent, finished } = setupExecutor();
    expect(executor.start(payload)).toEqual({ accepted: true });
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.event' &&
            message.event.type === 'env_request',
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (message) =>
        message.type === 'run.event' && message.event.type === 'env_request',
    );
    if (request?.type !== 'run.event' || request.event.type !== 'env_request') {
      throw new Error('Missing environment request.');
    }
    expect(JSON.stringify(request.event)).not.toContain(canary);

    executor.env(payload.runId, request.event.requestId, 'delivery-success', [
      { key: 'SERVICE_TOKEN', value: canary, secret: true },
      { key: 'ACCOUNT_ID', value: visible, secret: false },
    ]);
    await vi.waitFor(() => expect(finished()).toBeDefined());

    expect(writeEnvFile).toHaveBeenCalledWith(expect.any(String), [
      { key: 'SERVICE_TOKEN', value: canary, secret: true },
      { key: 'ACCOUNT_ID', value: visible, secret: false },
    ]);
    expect(
      sent.some(
        (message) =>
          message.type === 'run.event' &&
          message.event.type === 'env_stored' &&
          message.event.variables.every((variable) => !('value' in variable)),
      ),
    ).toBe(true);
    expect(
      sent.some(
        (message) =>
          message.type === 'run.env_result' &&
          message.deliveryId === 'delivery-success' &&
          message.ok,
      ),
    ).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(canary);
    expect(JSON.stringify(finished()?.messages)).not.toContain(canary);
    expect(JSON.stringify(finished()?.messages)).toContain(visible);

    // A replay can arrive after the tool settled; it still receives the exact
    // safe acknowledgement without values.
    executor.env(payload.runId, request.event.requestId, 'delivery-success', [
      { key: 'SERVICE_TOKEN', value: 'replayed', secret: true },
      { key: 'ACCOUNT_ID', value: visible, secret: false },
    ]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'run.env_result',
        deliveryId: 'delivery-success',
        ok: true,
      }),
    );

    // A delivery id's safe signature includes the final classifications.
    executor.env(payload.runId, request.event.requestId, 'delivery-success', [
      { key: 'SERVICE_TOKEN', value: 'different', secret: false },
      { key: 'ACCOUNT_ID', value: visible, secret: false },
    ]);
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'run.env_result',
        deliveryId: 'delivery-success',
        ok: false,
        errorCode: 'request_mismatch',
      }),
    );
    executor.ackFinish(payload.runId);
  });

  it('keeps a failed request pending so a later delivery can retry', async () => {
    vi.mocked(writeEnvFile)
      .mockRejectedValueOnce(new Error('disk failed'))
      .mockResolvedValueOnce(undefined);
    vi.mocked(runAgentTurn).mockImplementationOnce(async (options) => {
      await options.requestEnv?.('Need access.', [
        { key: 'TOKEN', description: 'Token.', secret: true },
      ]);
      return { messages: [] };
    });
    const { executor, sent, finished } = setupExecutor();
    executor.start(payload);
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.event' &&
            message.event.type === 'env_request',
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (message) =>
        message.type === 'run.event' && message.event.type === 'env_request',
    );
    if (request?.type !== 'run.event' || request.event.type !== 'env_request') {
      throw new Error('Missing environment request.');
    }

    executor.env(payload.runId, request.event.requestId, 'delivery-first', [
      { key: 'TOKEN', value: 'first-attempt', secret: true },
    ]);
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.env_result' &&
            message.deliveryId === 'delivery-first' &&
            !message.ok &&
            message.errorCode === 'write_failed',
        ),
      ).toBe(true),
    );
    expect(finished()).toBeUndefined();

    executor.env(payload.runId, request.event.requestId, 'delivery-second', [
      { key: 'TOKEN', value: 'second-attempt', secret: true },
    ]);
    await vi.waitFor(() => expect(finished()).toBeDefined());
    expect(writeEnvFile).toHaveBeenCalledTimes(2);
    executor.ackFinish(payload.runId);
  });

  it('rejects a mismatched key set without writing', async () => {
    vi.mocked(runAgentTurn).mockImplementationOnce(async (options) => {
      await options.requestEnv?.('Need access.', [
        { key: 'TOKEN', description: 'Token.', secret: true },
      ]);
      return { messages: [] };
    });
    const { executor, sent } = setupExecutor();
    executor.start(payload);
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.event' &&
            message.event.type === 'env_request',
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (message) =>
        message.type === 'run.event' && message.event.type === 'env_request',
    );
    if (request?.type !== 'run.event' || request.event.type !== 'env_request') {
      throw new Error('Missing environment request.');
    }
    executor.env(payload.runId, request.event.requestId, 'delivery-mismatch', [
      { key: 'OTHER_TOKEN', value: 'value', secret: true },
    ]);

    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.env_result' &&
            message.deliveryId === 'delivery-mismatch' &&
            !message.ok &&
            message.errorCode === 'request_mismatch',
        ),
      ).toBe(true),
    );
    expect(writeEnvFile).not.toHaveBeenCalled();
    executor.cancel(payload.runId);
    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === 'run.finished')).toBe(
        true,
      ),
    );
    executor.ackFinish(payload.runId);
  });

  it('correlates concurrent deliveries and acknowledges a write after cancel', async () => {
    let finishWrite!: () => void;
    vi.mocked(writeEnvFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    vi.mocked(runAgentTurn).mockImplementationOnce(async (options) => {
      try {
        await options.requestEnv?.('Need access.', [
          { key: 'TOKEN', description: 'Token.', secret: true },
        ]);
      } catch {
        // Cancellation rejects the bridge and must not expose a later value.
      }
      return { messages: [{ role: 'assistant', content: 'cancelled safely' }] };
    });
    const { executor, sent, finished } = setupExecutor();
    executor.start(payload);
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) =>
            message.type === 'run.event' &&
            message.event.type === 'env_request',
        ),
      ).toBe(true),
    );
    const request = sent.find(
      (message) =>
        message.type === 'run.event' && message.event.type === 'env_request',
    );
    if (request?.type !== 'run.event' || request.event.type !== 'env_request') {
      throw new Error('Missing environment request.');
    }

    executor.env(payload.runId, request.event.requestId, 'delivery-a', [
      { key: 'TOKEN', value: 'first-value', secret: false },
    ]);
    executor.env(payload.runId, request.event.requestId, 'delivery-b', [
      { key: 'TOKEN', value: 'second-value', secret: true },
    ]);
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'run.env_result',
          deliveryId: 'delivery-b',
          ok: false,
          errorCode: 'delivery_busy',
        }),
      ),
    );
    expect(writeEnvFile).toHaveBeenCalledOnce();

    executor.cancel(payload.runId);
    await vi.waitFor(() => expect(finished()?.status).toBe('cancelled'));
    finishWrite();
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'run.env_result',
          deliveryId: 'delivery-a',
          ok: true,
        }),
      ),
    );
    expect(
      sent.some(
        (message) =>
          message.type === 'run.event' && message.event.type === 'env_stored',
      ),
    ).toBe(false);
    expect(JSON.stringify(finished()?.messages)).not.toContain('first-value');
    executor.ackFinish(payload.runId);
  });
});

describe('RunnerExecutor terminal outcomes', () => {
  it('rejects before claiming a session whose workspace cannot be prepared', () => {
    vi.mocked(prepareAgentSessionSandbox).mockImplementationOnce(() => {
      throw new Error('unsafe workspace layout');
    });
    const { executor, sent } = setupExecutor();

    expect(executor.start(payload)).toEqual({
      accepted: false,
      reason: 'unsafe workspace layout',
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(executor.activeCount).toBe(0);
  });

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
    const { executor, finished } = setupExecutor(TAVILY_API_KEY);

    expect(executor.start(payload)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(finished()).toBeDefined());

    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        appUrl: APP_URL,
        tavilyApiKey: TAVILY_API_KEY,
        composerContent: [],
      }),
    );

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
