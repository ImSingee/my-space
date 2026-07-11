import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import { afterAll, describe, expect, it } from 'vitest';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';

// runtime.ts resolves its workspace paths at module load, so point it at an
// isolated temporary root before importing it.
const originalDataDir = process.env.HATCH_DATA_DIR;
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-agent-runtime-test-'));
process.env.HATCH_DATA_DIR = dataDir;
const { runAgentTurn } = await import('./runtime');

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.HATCH_DATA_DIR;
  else process.env.HATCH_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const stubPlatform = new Proxy({} as PlatformClient, {
  get(_target, prop) {
    return () => {
      throw new Error(`Unexpected PlatformClient.${String(prop)} call.`);
    };
  },
});

async function runWithResponse(
  response: ReturnType<typeof fauxAssistantMessage>,
  sessionId: string,
) {
  const providerId = `runtime-test-${sessionId}`;
  const faux = fauxProvider({ provider: providerId });
  faux.setResponses([response]);
  const models = createModels();
  models.setProvider(faux.provider);
  const picked: ResolvedModel = {
    providerId,
    providerName: 'Runtime Test',
    apiType: 'openai-responses',
    model: faux.getModel() as ResolvedModel['model'],
  };

  return runAgentTurn({
    priorMessages: [],
    sessionId,
    userText: 'hello',
    models,
    picked,
    platform: stubPlatform,
    signal: new AbortController().signal,
    emit: () => {},
  });
}

describe('runAgentTurn terminal outcomes', () => {
  it('propagates a resolved provider error with its transcript', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      }),
      'provider-error',
    );

    expect(result.error).toBe('OpenAI API error (402): no body');
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'OpenAI API error (402): no body',
    });
  });

  it('uses a stable fallback when a provider error has no message', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage([], { stopReason: 'error' }),
      'provider-error-fallback',
    );

    expect(result.error).toBe('Agent run failed.');
  });

  it('propagates an aborted result without dropping partial content', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage([fauxText('partial reply')], {
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
      }),
      'aborted',
    );

    expect(result.error).toBe('Request was aborted');
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial reply' }],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
    });
  });

  it('keeps a successful response successful', async () => {
    const result = await runWithResponse(
      fauxAssistantMessage('done'),
      'success',
    );

    expect(result.error).toBeUndefined();
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
    });
  });
});
