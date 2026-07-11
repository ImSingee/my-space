import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '~/db/schema';
import type { AgentRunInput } from './agent-runs';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('~server/agent-runner/hub', () => {
  type Hub = typeof import('~server/agent-runner/hub');
  return {
    connectedRunnerCount: vi.fn<Hub['connectedRunnerCount']>(() => 1),
    dispatchRun: vi.fn<Hub['dispatchRun']>(async () => 'runner-test'),
  };
});

const { db, schema } = await import('~/db');
const hub = await import('~server/agent-runner/hub');
const { startAgentRun } = await import('./agent-runs');

const PROVIDER_ID = 'provider-retry';
const MODEL_ID = 'model-retry';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(hub.connectedRunnerCount).mockReturnValue(1);
  vi.mocked(hub.dispatchRun).mockResolvedValue('runner-test');
  await db.delete(schema.agentRunEvents);
  await db.delete(schema.agentRuns);
  await db.delete(schema.agentSessions);
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
});

async function seedModel() {
  await db.insert(schema.agentProviders).values({
    id: PROVIDER_ID,
    name: 'Retry Provider',
    apiType: 'openai-responses',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
  });
  await db.insert(schema.agentModels).values({
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    name: 'Retry Model',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
  });
}

async function seedSession(id: string, messages: JsonValue[]) {
  await db.insert(schema.agentSessions).values({
    id,
    title: 'Retry session',
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    messages,
  });
}

describe('startAgentRun retry', () => {
  it('replaces the failed tail and dispatches only the truncated history', async () => {
    await seedModel();
    const baseMessages: JsonValue[] = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier response' }],
        stopReason: 'stop',
      },
    ];
    await seedSession('session-retry', [
      ...baseMessages,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Failed request' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial response' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ]);

    // Even an internal caller that bypasses the strict HTTP schema cannot
    // override a retry's persisted prompt, images, provider, or model.
    const { runId } = await startAgentRun({
      sessionId: 'session-retry',
      retry: true,
      userText: 'Malicious client override',
      images: [{ data: 'ZXZpbA==', mimeType: 'image/jpeg' }],
      providerId: 'provider-override',
      modelId: 'model-override',
    } as unknown as AgentRunInput);

    const session = await db.query.agentSessions.findFirst({
      where: (row, { eq }) => eq(row.id, 'session-retry'),
    });
    expect(session?.messages).toEqual([
      ...baseMessages,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Failed request' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        ],
      },
    ]);

    expect(hub.dispatchRun).toHaveBeenCalledWith({
      runId,
      sessionId: 'session-retry',
      userText: 'Failed request',
      images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
      priorMessages: baseMessages,
      model: expect.objectContaining({
        providerId: PROVIDER_ID,
        model: expect.objectContaining({ id: MODEL_ID }),
      }),
    });

    const run = await db.query.agentRuns.findFirst({
      where: (row, { eq }) => eq(row.id, runId),
    });
    expect(run).toMatchObject({
      status: 'running',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      input: {
        userText: 'Failed request',
        images: [{ mimeType: 'image/png' }],
      },
    });
  });

  it('returns a conflict when the transcript has no retryable error', async () => {
    await seedSession('session-not-retryable', [
      { role: 'user', content: 'Already handled' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        stopReason: 'stop',
      },
    ]);

    await expect(
      startAgentRun({ sessionId: 'session-not-retryable', retry: true }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'There is no failed Agent turn to retry.',
    });
    expect(hub.dispatchRun).not.toHaveBeenCalled();
  });

  it('keeps normal sends append-only even after an error', async () => {
    await seedModel();
    const existingMessages: JsonValue[] = [
      { role: 'user', content: 'Failed request' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];
    await seedSession('session-normal-send', existingMessages);

    const { runId } = await startAgentRun({
      sessionId: 'session-normal-send',
      userText: 'A distinct new request',
      images: [],
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });

    const session = await db.query.agentSessions.findFirst({
      where: (row, { eq }) => eq(row.id, 'session-normal-send'),
    });
    expect(session?.messages).toEqual([
      ...existingMessages,
      {
        role: 'user',
        content: [{ type: 'text', text: 'A distinct new request' }],
      },
    ]);
    expect(hub.dispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        userText: 'A distinct new request',
        priorMessages: existingMessages,
      }),
    );
  });
});
