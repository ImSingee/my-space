import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRunModels } from '~agent/remote-models';

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder = {
      middleware: () => builder,
      validator: (next: (value: never) => unknown) => {
        validate = (value) => next(value as never);
        return builder;
      },
      handler:
        (handler: (context: { data: never }) => unknown) =>
        async (input: { data: unknown }) =>
          handler({ data: validate(input.data) as never }),
    };
    return builder;
  },
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('./auth', () => ({ authMiddleware: {} }));

const { db, schema } = await import('~/db');
const { createModel } = await import('./providers');

beforeEach(async () => {
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
  await db.insert(schema.agentProviders).values({
    id: 'provider',
    name: 'Local',
    apiType: 'openai-responses',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-key',
  });
});

async function modelById(id: string) {
  return db.query.agentModels.findFirst({ where: { id } });
}

describe('unconditional model image input', () => {
  it('sends custom-model images despite legacy text-only settings', async () => {
    const legacySettings = {
      providerId: 'provider',
      modelId: 'gpt-6.1-sol',
      name: 'Sol',
      input: ['text'],
    };
    const { id } = await createModel({ data: legacySettings });
    const stored = (await modelById(id))!;
    expect(stored).not.toHaveProperty('input');

    const { models, picked } = buildRunModels({
      providerId: 'provider',
      providerName: 'Local',
      apiType: 'openai-responses',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
      model: {
        id: stored.modelId,
        name: stored.name,
        // Old Platforms may still send this metadata; the Runner ignores it.
        input: ['text'],
        reasoning: stored.reasoning,
        contextWindow: stored.contextWindow,
        maxTokens: stored.maxTokens,
      },
    });
    let requestBody: unknown;
    const result = await models.completeSimple(
      picked.model,
      {
        messages: [
          {
            role: 'user',
            timestamp: 1,
            content: [
              { type: 'text', text: 'Read this image' },
              { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            ],
          },
        ],
      },
      {
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return new Response(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: { id: 'response', status: 'completed', output: [] },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
    );
    expect(result.stopReason).toBe('stop');
    expect(requestBody).toMatchObject({
      model: 'gpt-6.1-sol',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read this image' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,aW1hZ2U=',
            },
          ],
        },
      ],
    });
  });
});
