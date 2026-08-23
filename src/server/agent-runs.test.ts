import { eq } from 'drizzle-orm';
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
    sendRunEnvAndWait: vi.fn<Hub['sendRunEnvAndWait']>(async () => ({
      ok: true,
    })),
  };
});

const { db, schema } = await import('~/db');
const hub = await import('~server/agent-runner/hub');
const {
  assignRunToRunner,
  completeRunFromRunner,
  finalizeRunWorkspaceAffinity,
  getActiveAgentRun,
  getSessionWorkspaceAffinity,
  ingestRunnerEvent,
  startAgentRun,
  submitAgentEnv,
} = await import('./agent-runs');

const PROVIDER_A_ID = 'provider-a';
const MODEL_A_ID = 'model-a';
const PROVIDER_B_ID = 'provider-b';
const MODEL_B_ID = 'model-b';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(hub.connectedRunnerCount).mockReturnValue(1);
  vi.mocked(hub.dispatchRun).mockResolvedValue('runner-test');
  vi.mocked(hub.sendRunEnvAndWait).mockResolvedValue({ ok: true });
  await db.delete(schema.agentRunEvents);
  await db.delete(schema.agentRuns);
  await db.delete(schema.agentAttachments);
  await db.delete(schema.agentSessions);
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
});

async function seedModel(providerId: string, modelId: string, name: string) {
  await db.insert(schema.agentProviders).values({
    id: providerId,
    name: `${name} Provider`,
    apiType: 'openai-responses',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
  });
  await db.insert(schema.agentModels).values({
    providerId,
    modelId,
    name: `${name} Model`,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
  });
}

async function seedAvailableModels() {
  await seedModel(PROVIDER_A_ID, MODEL_A_ID, 'A');
  await seedModel(PROVIDER_B_ID, MODEL_B_ID, 'B');
}

async function seedSession(id: string, messages: JsonValue[]) {
  const [session] = await db
    .insert(schema.agentSessions)
    .values({
      id,
      title: 'Retry session',
      providerId: PROVIDER_A_ID,
      modelId: MODEL_A_ID,
      messages,
    })
    .returning({ updatedAt: schema.agentSessions.updatedAt });
  return session.updatedAt.toISOString();
}

async function seedEnvRun(runId = 'run-secret') {
  await seedAvailableModels();
  await seedSession('session-secret', []);
  await db.insert(schema.agentRuns).values({
    id: runId,
    sessionId: 'session-secret',
    providerId: PROVIDER_A_ID,
    modelId: MODEL_A_ID,
    status: 'running',
    input: { userText: 'Deploy the app' },
    runnerId: 'runner-test',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
}

describe('session workspace affinity', () => {
  it('finalizes an unowned session only after the assigned runner accepts', async () => {
    await seedEnvRun('run-affinity');
    await db
      .update(schema.agentRuns)
      .set({ runnerId: null })
      .where(eq(schema.agentRuns.id, 'run-affinity'));

    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'uninitialized', runnerId: null });
    await assignRunToRunner('run-affinity', 'session-secret', 'runner-owner');
    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'uninitialized', runnerId: null });
    await expect(
      finalizeRunWorkspaceAffinity(
        'run-affinity',
        'runner-owner',
        'session-secret',
      ),
    ).resolves.toBe('session-secret');
    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'claimed', runnerId: 'runner-owner' });
    await expect(
      assignRunToRunner('run-affinity', 'session-secret', 'runner-different'),
    ).rejects.toThrow('belongs to another Runner');

    const run = await db.query.agentRuns.findFirst({
      where: { id: 'run-affinity' },
    });
    expect(run?.runnerId).toBe('runner-owner');
  });

  it('does not pin a session when a provisional dispatch never accepts', async () => {
    await seedEnvRun('run-provisional');
    await db
      .update(schema.agentRuns)
      .set({ runnerId: null })
      .where(eq(schema.agentRuns.id, 'run-provisional'));

    await assignRunToRunner(
      'run-provisional',
      'session-secret',
      'runner-owner',
    );
    await db
      .update(schema.agentRuns)
      .set({ status: 'failed' })
      .where(eq(schema.agentRuns.id, 'run-provisional'));

    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'uninitialized', runnerId: null });
  });

  it('finalizes affinity when a finish report races terminal cancellation', async () => {
    await seedEnvRun('run-cancelled-before-finish');
    await db
      .update(schema.agentRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(eq(schema.agentRuns.id, 'run-cancelled-before-finish'));

    await expect(
      completeRunFromRunner('runner-test', {
        runId: 'run-cancelled-before-finish',
        status: 'cancelled',
        messages: [],
      }),
    ).resolves.toBe('session-secret');
    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'claimed', runnerId: 'runner-test' });
  });
});

describe('environment request delivery', () => {
  it('persists only safe request metadata and clears it on matching storage', async () => {
    const canary = 'plaintext-canary-must-not-be-persisted';
    await seedEnvRun();

    await expect(
      ingestRunnerEvent('runner-test', {
        runId: 'run-secret',
        runnerSeq: 1,
        event: {
          type: 'env_request',
          requestId: 'secret-1',
          reason: 'Deploy to the service',
          variables: [
            {
              key: 'SERVICE_TOKEN',
              description: 'Service API token',
              secret: false,
            },
          ],
        },
      }),
    ).resolves.toEqual({ status: 'ok', sessionId: 'session-secret' });

    await expect(
      getSessionWorkspaceAffinity('session-secret'),
    ).resolves.toEqual({ state: 'claimed', runnerId: 'runner-test' });

    expect(await getActiveAgentRun('session-secret')).toMatchObject({
      id: 'run-secret',
      status: 'blocked',
      pendingEnvRequest: {
        requestId: 'secret-1',
        reason: 'Deploy to the service',
        variables: [
          {
            key: 'SERVICE_TOKEN',
            description: 'Service API token',
            secret: false,
          },
        ],
      },
    });

    await submitAgentEnv('run-secret', 'secret-1', [
      { key: 'SERVICE_TOKEN', value: canary, secret: true },
    ]);
    expect(hub.sendRunEnvAndWait).toHaveBeenCalledWith(
      'runner-test',
      'run-secret',
      'secret-1',
      [{ key: 'SERVICE_TOKEN', value: canary, secret: true }],
    );

    // Delivery acknowledgement is transient; only the Runner's safe event
    // advances the persisted run state.
    expect(await getActiveAgentRun('session-secret')).toMatchObject({
      status: 'blocked',
      pendingEnvRequest: { requestId: 'secret-1' },
    });
    await ingestRunnerEvent('runner-test', {
      runId: 'run-secret',
      runnerSeq: 2,
      event: {
        type: 'env_stored',
        requestId: 'secret-1',
        variables: [{ key: 'SERVICE_TOKEN', secret: true }],
      },
    });

    expect(await getActiveAgentRun('session-secret')).toMatchObject({
      status: 'running',
      pendingEnvRequest: null,
    });
    const persisted = {
      runs: await db.query.agentRuns.findMany(),
      events: await db.query.agentRunEvents.findMany(),
      sessions: await db.query.agentSessions.findMany(),
    };
    expect(JSON.stringify(persisted)).not.toContain(canary);
    expect(persisted.events.map((event) => event.payload)).toEqual([
      {
        type: 'env_request',
        requestId: 'secret-1',
        reason: 'Deploy to the service',
        variables: [
          {
            key: 'SERVICE_TOKEN',
            description: 'Service API token',
            secret: false,
          },
        ],
      },
      {
        type: 'env_stored',
        requestId: 'secret-1',
        variables: [{ key: 'SERVICE_TOKEN', secret: true }],
      },
    ]);
  });

  it('does not let stale acknowledgements clear a newer request', async () => {
    await seedEnvRun();
    await ingestRunnerEvent('runner-test', {
      runId: 'run-secret',
      runnerSeq: 1,
      event: {
        type: 'env_request',
        requestId: 'secret-current',
        reason: 'Need credentials',
        variables: [{ key: 'TOKEN', description: 'Token', secret: true }],
      },
    });
    await ingestRunnerEvent('runner-test', {
      runId: 'run-secret',
      runnerSeq: 2,
      event: {
        type: 'env_stored',
        requestId: 'secret-old',
        variables: [{ key: 'TOKEN', secret: true }],
      },
    });

    expect(await getActiveAgentRun('session-secret')).toMatchObject({
      status: 'blocked',
      pendingEnvRequest: { requestId: 'secret-current' },
    });
  });

  it('rejects conflicting keys and maps transient delivery failures', async () => {
    await seedEnvRun();
    await ingestRunnerEvent('runner-test', {
      runId: 'run-secret',
      runnerSeq: 1,
      event: {
        type: 'env_request',
        requestId: 'secret-1',
        reason: 'Need two credentials',
        variables: [
          { key: 'TOKEN', description: 'Token', secret: true },
          { key: 'ACCOUNT_ID', description: 'Account id', secret: false },
        ],
      },
    });

    await expect(
      submitAgentEnv('run-secret', 'secret-1', [
        { key: 'TOKEN', value: 'value', secret: true },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect(hub.sendRunEnvAndWait).not.toHaveBeenCalled();

    vi.mocked(hub.sendRunEnvAndWait).mockResolvedValueOnce({
      ok: false,
      errorCode: 'runner_timeout',
    });
    await expect(
      submitAgentEnv('run-secret', 'secret-1', [
        { key: 'ACCOUNT_ID', value: 'account', secret: true },
        { key: 'TOKEN', value: 'value', secret: false },
      ]),
    ).rejects.toMatchObject({
      status: 504,
      message: 'Agent Runner did not confirm environment storage.',
    });
    expect(await getActiveAgentRun('session-secret')).toMatchObject({
      status: 'blocked',
      pendingEnvRequest: { requestId: 'secret-1' },
    });

    vi.mocked(hub.sendRunEnvAndWait).mockResolvedValueOnce({
      ok: false,
      errorCode: 'write_failed',
    });
    await expect(
      submitAgentEnv('run-secret', 'secret-1', [
        { key: 'TOKEN', value: 'value', secret: false },
        { key: 'ACCOUNT_ID', value: 'account', secret: true },
      ]),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Agent Runner could not store the environment.',
    });
  });
});

describe('startAgentRun retry', () => {
  it('replaces the failed tail and retries it with the requested latest model', async () => {
    await seedAvailableModels();
    const baseMessages: JsonValue[] = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier response' }],
        stopReason: 'stop',
      },
    ];
    const expectedSessionUpdatedAt = await seedSession('session-retry', [
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
    // override a retry's persisted prompt or images. The requested model is
    // intentional: the user switched from the session's A model to B.
    const { runId } = await startAgentRun({
      sessionId: 'session-retry',
      retry: true,
      expectedSessionUpdatedAt,
      userText: 'Malicious client override',
      images: [{ data: 'ZXZpbA==', mimeType: 'image/jpeg' }],
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    } as unknown as AgentRunInput);

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'session-retry' },
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
    expect(session).toMatchObject({
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });

    expect(hub.dispatchRun).toHaveBeenCalledWith({
      runId,
      sessionId: 'session-retry',
      userText: 'Failed request',
      images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
      attachments: [],
      priorMessages: baseMessages,
      model: expect.objectContaining({
        providerId: PROVIDER_B_ID,
        model: expect.objectContaining({ id: MODEL_B_ID }),
      }),
    });

    const run = await db.query.agentRuns.findFirst({
      where: { id: runId },
    });
    expect(run).toMatchObject({
      status: 'running',
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
      input: {
        userText: 'Failed request',
        images: [{ mimeType: 'image/png' }],
      },
    });
  });

  it('rejects a stale retry after a newer retry has failed again', async () => {
    await seedAvailableModels();
    const failedMessages: JsonValue[] = [
      { role: 'user', content: 'Failed request' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];
    const expectedSessionUpdatedAt = await seedSession(
      'session-stale-retry',
      failedMessages,
    );

    let signalProviderLookupStarted!: () => void;
    const providerLookupStarted = new Promise<void>((resolve) => {
      signalProviderLookupStarted = resolve;
    });
    let releaseProviderLookup!: () => void;
    const providerLookupReleased = new Promise<void>((resolve) => {
      releaseProviderLookup = resolve;
    });
    const originalFindProvider = db.query.agentProviders.findFirst.bind(
      db.query.agentProviders,
    );
    const delayedFindProvider = ((
      options: Parameters<typeof originalFindProvider>[0],
    ) => {
      signalProviderLookupStarted();
      return providerLookupReleased.then(() => originalFindProvider(options));
    }) as unknown as typeof db.query.agentProviders.findFirst;
    const findProviderSpy = vi
      .spyOn(db.query.agentProviders, 'findFirst')
      .mockImplementationOnce(delayedFindProvider);

    const staleRetry = startAgentRun({
      sessionId: 'session-stale-retry',
      retry: true,
      expectedSessionUpdatedAt,
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });
    await providerLookupStarted;

    const freshRetry = await startAgentRun({
      sessionId: 'session-stale-retry',
      retry: true,
      expectedSessionUpdatedAt,
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });
    const failedAgainMessages: JsonValue[] = [
      { role: 'user', content: 'Failed request' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Another partial response' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable again',
      },
    ];
    await db
      .update(schema.agentSessions)
      .set({ messages: failedAgainMessages })
      .where(eq(schema.agentSessions.id, 'session-stale-retry'));
    await db
      .update(schema.agentRuns)
      .set({
        status: 'failed',
        error: 'Provider unavailable again',
        completedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, freshRetry.runId));

    // A duplicate that only reaches the server after the new failure is stale
    // too: its client-supplied revision still identifies the original error.
    await expect(
      startAgentRun({
        sessionId: 'session-stale-retry',
        retry: true,
        expectedSessionUpdatedAt,
        providerId: PROVIDER_B_ID,
        modelId: MODEL_B_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'There is no failed Agent turn to retry.',
    });

    releaseProviderLookup();
    await expect(staleRetry).rejects.toMatchObject({
      status: 409,
      message: 'There is no failed Agent turn to retry.',
    });
    findProviderSpy.mockRestore();

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'session-stale-retry' },
    });
    expect(session?.messages).toEqual(failedAgainMessages);
    expect(session?.updatedAt.toISOString()).not.toBe(expectedSessionUpdatedAt);
    expect(await db.query.agentRuns.findMany()).toHaveLength(1);
    expect(hub.dispatchRun).toHaveBeenCalledTimes(1);

    // A new click rendered from the new failure revision remains valid.
    const intentionalRetry = await startAgentRun({
      sessionId: 'session-stale-retry',
      retry: true,
      expectedSessionUpdatedAt: session!.updatedAt.toISOString(),
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });
    expect(intentionalRetry.runId).not.toBe(freshRetry.runId);
    expect(await db.query.agentRuns.findMany()).toHaveLength(2);
    expect(hub.dispatchRun).toHaveBeenCalledTimes(2);
  });

  it('returns a conflict when the transcript has no retryable error', async () => {
    const expectedSessionUpdatedAt = await seedSession(
      'session-not-retryable',
      [
        { role: 'user', content: 'Already handled' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'stop',
        },
      ],
    );

    await expect(
      startAgentRun({
        sessionId: 'session-not-retryable',
        retry: true,
        expectedSessionUpdatedAt,
        providerId: PROVIDER_B_ID,
        modelId: MODEL_B_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'There is no failed Agent turn to retry.',
    });
    expect(hub.dispatchRun).not.toHaveBeenCalled();
  });

  it('keeps normal sends append-only and persists the requested latest model', async () => {
    await seedAvailableModels();
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
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'session-normal-send' },
    });
    expect(session?.messages).toEqual([
      ...existingMessages,
      {
        role: 'user',
        content: [{ type: 'text', text: 'A distinct new request' }],
      },
    ]);
    expect(session).toMatchObject({
      providerId: PROVIDER_B_ID,
      modelId: MODEL_B_ID,
    });
    expect(hub.dispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        userText: 'A distinct new request',
        priorMessages: existingMessages,
        model: expect.objectContaining({
          providerId: PROVIDER_B_ID,
          model: expect.objectContaining({ id: MODEL_B_ID }),
        }),
      }),
    );
  });

  it('attaches only files uploaded for this session and marks them referenced', async () => {
    await seedAvailableModels();
    await seedSession('session-attachments', []);
    await seedSession('session-other', []);
    await db.insert(schema.agentAttachments).values([
      {
        id: 'document-a',
        sessionId: 'session-attachments',
        name: 'document.pdf',
        contentType: 'application/pdf',
        size: 123,
      },
      {
        id: 'document-other',
        sessionId: 'session-other',
        name: 'other.pdf',
        contentType: 'application/pdf',
        size: 456,
      },
    ]);

    const { runId } = await startAgentRun({
      sessionId: 'session-attachments',
      userText: 'Inspect this file',
      attachmentIds: ['document-a'],
      providerId: PROVIDER_A_ID,
      modelId: MODEL_A_ID,
    });

    const attachment = await db.query.agentAttachments.findFirst({
      where: { id: 'document-a' },
    });
    expect(attachment?.attachedAt).toBeInstanceOf(Date);
    const session = await db.query.agentSessions.findFirst({
      where: { id: 'session-attachments' },
    });
    expect(session?.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: expect.stringContaining('id=document-a'),
          },
        ],
        attachments: [
          {
            id: 'document-a',
            name: 'document.pdf',
            mimeType: 'application/pdf',
            size: 123,
          },
        ],
      },
    ]);
    expect(hub.dispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        sessionId: 'session-attachments',
        attachments: [
          {
            id: 'document-a',
            name: 'document.pdf',
            mimeType: 'application/pdf',
            size: 123,
          },
        ],
      }),
    );

    await db
      .update(schema.agentRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    await expect(
      startAgentRun({
        sessionId: 'session-attachments',
        userText: 'Try another session file',
        attachmentIds: ['document-other'],
        providerId: PROVIDER_A_ID,
        modelId: MODEL_A_ID,
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: 'One or more attachments were not found.',
    });
  });

  it('rejects an unavailable selected model without changing the failed turn', async () => {
    await seedAvailableModels();
    await db
      .update(schema.agentModels)
      .set({ enabled: false })
      .where(eq(schema.agentModels.providerId, PROVIDER_B_ID));
    const failedMessages: JsonValue[] = [
      { role: 'user', content: 'Failed request' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];
    const expectedSessionUpdatedAt = await seedSession(
      'session-disabled-model',
      failedMessages,
    );

    await expect(
      startAgentRun({
        sessionId: 'session-disabled-model',
        retry: true,
        expectedSessionUpdatedAt,
        providerId: PROVIDER_B_ID,
        modelId: MODEL_B_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'The selected Agent model is unavailable.',
    });

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'session-disabled-model' },
    });
    expect(session).toMatchObject({
      messages: failedMessages,
      providerId: PROVIDER_A_ID,
      modelId: MODEL_A_ID,
    });
    expect(await db.query.agentRuns.findMany()).toHaveLength(0);
    expect(hub.dispatchRun).not.toHaveBeenCalled();
  });
});
