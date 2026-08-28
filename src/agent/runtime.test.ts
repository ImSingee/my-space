import { Buffer } from 'node:buffer';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentComposerContentPart } from './composer-content';
import type { AgentStreamEvent } from './events';
import type { PlatformClient } from './platform-client';
import type { ResolvedModel } from './remote-models';
import type { EnvBridge } from './tools';
import { MAX_EDIT_DETAILS_BYTES } from './tools/edit-diff';
import { MAX_WEB_SEARCH_CONTENT_CHARS } from './tools/web';

// runtime.ts resolves its workspace paths at module load, so point it at an
// isolated temporary root before importing it.
const originalDataDir = process.env.HATCH_DATA_DIR;
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-agent-runtime-test-'));
process.env.HATCH_DATA_DIR = dataDir;
const { runAgentTurn } = await import('./runtime');
const { agentWorkDir } = await import('./paths');
const { agentShellEnv } = await import('./shell-env');
const { writeEnvFile } = await import('./env-file');

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  responses: FauxResponseStep[],
  sessionId: string,
  emit: (event: AgentStreamEvent) => void = () => {},
  platform: PlatformClient = stubPlatform,
  requestEnv?: EnvBridge,
  priorMessages: AgentMessage[] = [],
  composerInput?: {
    userText: string;
    composerContent: AgentComposerContentPart[];
  },
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
    appUrl: 'https://hatch.example.test',
    priorMessages,
    sessionId,
    userText: composerInput?.userText ?? 'hello',
    ...(composerInput
      ? { composerContent: composerInput.composerContent }
      : {}),
    models,
    picked,
    platform,
    signal: new AbortController().signal,
    ...(requestEnv ? { requestEnv } : {}),
    emit,
  });
}

describe('runAgentTurn terminal outcomes', () => {
  it('keeps App snapshot metadata while exposing inline text to the model', async () => {
    const composerContent: AgentComposerContentPart[] = [
      { type: 'text', text: 'Review ' },
      {
        type: 'app',
        id: 'app-stable',
        name: 'Original Name',
        slug: 'original-slug',
      },
      { type: 'text', text: ' now.' },
    ];
    const userText =
      'Review @APP{name="Original Name" id="app-stable" slug="original-slug"} now.';
    const result = await runWithResponses(
      [
        (context) => {
          expect(JSON.stringify(context)).toContain(userText);
          return fauxAssistantMessage('Reviewed.');
        },
      ],
      'app-reference',
      () => {},
      stubPlatform,
      undefined,
      [],
      { userText, composerContent },
    );

    expect(result.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ composerContent })]),
    );
  });

  it('reveals only browser-classified non-secret values to the model', async () => {
    const sessionId = 'secret-canary';
    const canary = 'canary-secret-93b7f7c8-never-in-context';
    const visible = 'account-123';
    const events: AgentStreamEvent[] = [];
    const requestEnv: EnvBridge = async (_reason, variables) => {
      expect(variables).toEqual([
        {
          key: 'SERVICE_TOKEN',
          description: 'Read-only service token.',
          secret: true,
        },
        {
          key: 'ACCOUNT_ID',
          description: 'Public account identifier.',
          secret: true,
        },
      ]);
      await writeEnvFile(agentWorkDir(sessionId), [
        { key: variables[0].key, value: canary, secret: true },
        { key: variables[1].key, value: visible, secret: false },
      ]);
      return [
        { key: 'SERVICE_TOKEN', secret: true },
        { key: 'ACCOUNT_ID', value: visible, secret: false },
      ];
    };

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('request_env', {
            reason: 'Verify the private service.',
            variables: [
              {
                key: 'SERVICE_TOKEN',
                description: 'Read-only service token.',
                secret: true,
              },
              {
                key: 'ACCOUNT_ID',
                description: 'Public account identifier.',
                secret: true,
              },
            ],
          }),
        ),
        (context) => {
          expect(JSON.stringify(context)).not.toContain(canary);
          expect(JSON.stringify(context)).toContain(visible);
          return fauxAssistantMessage('Credentials are ready.');
        },
      ],
      sessionId,
      (event) => events.push(event),
      stubPlatform,
      requestEnv,
    );

    await expect(
      readFile(path.join(agentWorkDir(sessionId), '.env'), 'utf8'),
    ).resolves.toContain(canary);
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(JSON.stringify(result.messages)).not.toContain(canary);
    expect(JSON.stringify(result.messages)).toContain(visible);
    expect(result.error).toBeUndefined();
  });

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

  it('does not stream details from tools that did not opt in', async () => {
    const sessionId = 'non-streamed-app-details';
    const apps = Array.from({ length: 2_000 }, (_, index) => ({
      id: `app-${index}`,
      slug: `app-${index}`,
      name: `App ${index}`,
      description: `details-only-${'x'.repeat(128)}`,
      status: 'draft' as const,
      currentVersion: null,
      compatibility: null,
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

  it('registers web search, clips its event, and bounds each result field', async () => {
    const sessionId = 'web-search-output';
    const events: AgentStreamEvent[] = [];
    const results = Array.from({ length: 5 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      content: 'x'.repeat(10_000),
      score: 1 - index / 10,
    }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ query: 'web query', results }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('web_search', {
            query: 'web query',
            max_results: 5,
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolStart = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.name === 'web_search',
    );
    expect(toolStart).toMatchObject({
      label: 'Web search',
      args: { query: 'web query', max_results: 5 },
    });
    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'web_search',
    );
    const streamedOutput = toolEnd?.output;
    expect(streamedOutput).toHaveLength(4_014);
    expect(streamedOutput?.endsWith('\n… (truncated)')).toBe(true);

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'web_search',
    ) as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const fullOutput = toolResult?.content?.[0]?.text;
    expect(fullOutput).toBeDefined();
    const output = JSON.parse(fullOutput ?? '{}') as {
      query?: string;
      results?: Array<{ content?: string; content_truncated?: boolean }>;
    };
    expect(output.query).toBe('web query');
    expect(output.results).toHaveLength(5);
    expect(output.results?.[0]).toMatchObject({
      content: 'x'.repeat(MAX_WEB_SEARCH_CONTENT_CHARS),
      content_truncated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get('X-Tavily-Access-Mode')).toBe(
      'keyless',
    );
  });

  it('keeps the Tavily key out of the model shell environment', () => {
    const original = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'tvly-shell-secret';
    try {
      expect(agentShellEnv('tavily-shell-env').TAVILY_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = original;
    }
  });

  it('streams only canonical path details for a successful write', async () => {
    const sessionId = 'streamed-write-details';
    const cwd = agentWorkDir(sessionId);
    const content = '  first line\n\nlast line\n';
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall('write_file', {
            path: './nested/file.txt',
            content,
          }),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );

    const toolStart = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start' && event.name === 'write_file',
    );
    expect(toolStart?.args).toEqual({
      path: './nested/file.txt',
      content,
    });
    const absolutePath = await realpath(path.join(cwd, 'nested/file.txt'));
    expect(toolStart?.details).toEqual({
      relativePath: 'nested/file.txt',
      absolutePath,
    });

    const toolEnd = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        event.type === 'tool_end' && event.name === 'write_file',
    );
    expect(toolEnd?.details).toEqual({
      path: 'nested/file.txt',
      relativePath: 'nested/file.txt',
      absolutePath,
    });

    const toolResult = result.messages.find(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolName === 'write_file',
    ) as { details?: unknown } | undefined;
    expect(toolResult?.details).toEqual({
      path: 'nested/file.txt',
      relativePath: 'nested/file.txt',
      absolutePath,
    });
    await expect(
      readFile(path.join(cwd, 'nested/file.txt'), 'utf8'),
    ).resolves.toBe(content);
  });

  it('persists the attempted path when a write fails validation', async () => {
    const toolName = 'write_file';
    const args = { path: 'missing-content.txt' };
    const sessionId = 'invalid-write-file';
    const events: AgentStreamEvent[] = [];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(fauxToolCall(toolName, args)),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      (event) => events.push(event),
    );
    const canonicalCwd = await realpath(agentWorkDir(sessionId));
    const expectedDetails = {
      relativePath: args.path,
      absolutePath: path.join(canonicalCwd, args.path),
    };

    expect(
      events.find(
        (event) => event.type === 'tool_start' && event.name === toolName,
      ),
    ).toMatchObject({ details: expectedDetails });
    expect(
      events.find(
        (event) => event.type === 'tool_end' && event.name === toolName,
      ),
    ).toMatchObject({ isError: true, details: expectedDetails });
    expect(
      result.messages.find(
        (message) =>
          message !== null &&
          typeof message === 'object' &&
          !Array.isArray(message) &&
          message.role === 'toolResult' &&
          message.toolName === toolName,
      ),
    ).toMatchObject({ isError: true, details: expectedDetails });
  });

  it('does not apply current path details to a prior reused tool-call id', async () => {
    const sessionId = 'reused-file-call-id';
    const toolCallId = 'shared-read-id';
    const priorMessages: AgentMessage[] = [
      fauxAssistantMessage(
        fauxToolCall('read_file', { path: 'legacy.txt' }, { id: toolCallId }),
      ),
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'read_file',
        content: [{ type: 'text', text: 'legacy contents' }],
        details: { path: 'legacy.txt' },
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const result = await runWithResponses(
      [
        fauxAssistantMessage(
          fauxToolCall(
            'read_file',
            { path: 'current.txt', limit: 0 },
            { id: toolCallId },
          ),
        ),
        fauxAssistantMessage('done'),
      ],
      sessionId,
      undefined,
      stubPlatform,
      undefined,
      priorMessages,
    );
    const matchingResults = result.messages.filter(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        !Array.isArray(message) &&
        message.role === 'toolResult' &&
        message.toolCallId === toolCallId,
    );
    const canonicalCwd = await realpath(agentWorkDir(sessionId));

    expect(matchingResults).toHaveLength(2);
    expect(matchingResults[0]).toMatchObject({
      details: { path: 'legacy.txt' },
    });
    expect(matchingResults[0]).not.toHaveProperty('details.relativePath');
    expect(matchingResults[1]).toMatchObject({
      details: {
        relativePath: 'current.txt',
        absolutePath: path.join(canonicalCwd, 'current.txt'),
      },
    });
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
