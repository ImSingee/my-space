import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from './events';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import { MAX_EDIT_DETAILS_BYTES } from './tools/edit-diff';

// runtime.ts resolves its workspace paths at module load, so point it at an
// isolated temporary root before importing it.
const originalDataDir = process.env.HATCH_DATA_DIR;
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-agent-runtime-test-'));
process.env.HATCH_DATA_DIR = dataDir;
const { runAgentTurn } = await import('./runtime');
const { agentWorkDir } = await import('./paths');

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
  return runWithResponses([response], sessionId);
}

async function runWithResponses(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  sessionId: string,
  emit: (event: AgentStreamEvent) => void = () => {},
  platform: PlatformClient = stubPlatform,
) {
  const providerId = `runtime-test-${sessionId}`;
  const faux = fauxProvider({ provider: providerId });
  faux.setResponses(responses);
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
    platform,
    signal: new AbortController().signal,
    emit,
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

  it('does not stream details from tools that did not opt in', async () => {
    const sessionId = 'non-streamed-app-details';
    const apps = Array.from({ length: 2_000 }, (_, index) => ({
      id: `app-${index}`,
      slug: `app-${index}`,
      name: `App ${index}`,
      description: `details-only-${'x'.repeat(128)}`,
      status: 'draft' as const,
      currentVersion: null,
      capabilities: [],
      updatedAt: '2026-07-19T00:00:00.000Z',
    })) satisfies Awaited<ReturnType<PlatformClient['listApps']>>;
    const platform = {
      listApps: async () => apps,
    } as unknown as PlatformClient;
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(fauxToolCall('list_apps', {})),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
      platform,
    );

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'list_apps',
    );
    expect(toolEnd).toBeDefined();
    expect(toolEnd).not.toHaveProperty('details');
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: 'run.event',
          runId: sessionId,
          runnerSeq: 1,
          event: toolEnd,
        }),
        'utf8',
      ),
    ).toBeLessThan(8 * 1024);

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'list_apps',
    ) as { details?: { apps?: unknown[] } } | undefined;
    expect(toolResult?.details?.apps).toHaveLength(apps.length);
  });

  it('keeps large edit details bounded in stream and transcript payloads', async () => {
    const sessionId = 'bounded-edit-details';
    const cwd = agentWorkDir(sessionId);
    const original = `TOKEN${'🙂\\'.repeat(20_000)}`;
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, 'large.js'), original);
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('edit_file', {
            path: 'large.js',
            old_string: 'TOKEN',
            new_string: 'DONE',
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'edit_file',
    );
    expect(toolEnd?.details).toMatchObject({
      diffTruncated: true,
      patchOmitted: true,
    });
    expect(
      Buffer.byteLength(JSON.stringify(toolEnd?.details), 'utf8'),
    ).toBeLessThanOrEqual(MAX_EDIT_DETAILS_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: 'run.event',
          runId: sessionId,
          runnerSeq: 1,
          event: toolEnd,
        }),
        'utf8',
      ),
    ).toBeLessThan(MAX_EDIT_DETAILS_BYTES * 2);

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult',
    );
    expect(toolResult).toMatchObject({
      details: { diffTruncated: true, patchOmitted: true },
    });
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: 'run.finished',
          runId: sessionId,
          status: 'completed',
          messages: result.messages,
        }),
        'utf8',
      ),
    ).toBeLessThan(MAX_EDIT_DETAILS_BYTES * 2);
    await expect(readFile(path.join(cwd, 'large.js'), 'utf8')).resolves.toBe(
      original.replace('TOKEN', 'DONE'),
    );
  });
});
