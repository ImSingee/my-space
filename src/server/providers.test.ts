import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
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
const { createModel, updateModel } = await import('./providers');

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

describe('model image input', () => {
  it('sends images through pi for a newly configured custom model', async () => {
    const { id } = await createModel({
      data: { providerId: 'provider', modelId: 'gpt-6.1-sol', name: 'Sol' },
    });
    const stored = (await modelById(id))!;
    expect(stored.input).toEqual(['text', 'image']);

    const { models, picked } = buildRunModels({
      providerId: 'provider',
      providerName: 'Local',
      apiType: 'openai-responses',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
      model: {
        id: stored.modelId,
        name: stored.name,
        input: stored.input as Array<'text' | 'image'>,
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

  it('persists explicit text-only choices and allows existing models to enable images', async () => {
    const { id } = await createModel({
      data: {
        providerId: 'provider',
        modelId: 'custom-model',
        name: 'Custom',
        input: ['text'],
      },
    });
    await updateModel({ data: { id, name: 'Renamed' } });
    expect((await modelById(id))?.input).toEqual(['text']);
    await updateModel({ data: { id, input: ['text', 'image'] } });
    expect((await modelById(id))?.input).toEqual(['text', 'image']);
    await updateModel({ data: { id, input: ['text'] } });
    expect((await modelById(id))?.input).toEqual(['text']);
    await expect(updateModel({ data: { id, input: [] } })).rejects.toThrow(
      /Too small/,
    );
    expect((await modelById(id))?.input).toEqual(['text']);
  });

  it('repairs historical text defaults once without changing other input declarations', async () => {
    await db.insert(schema.agentModels).values([
      {
        id: 'legacy',
        providerId: 'provider',
        modelId: 'sol',
        name: 'Sol',
        input: ['text'],
      },
      {
        id: 'vision',
        providerId: 'provider',
        modelId: 'vision',
        name: 'Vision',
        input: ['text', 'image'],
      },
      {
        id: 'other',
        providerId: 'provider',
        modelId: 'other',
        name: 'Other',
        input: ['image'],
      },
    ]);
    const migration = await readFile(
      new URL(
        '../../migrations/20261016161750_faulty_inhumans/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const statement of migration.split('--> statement-breakpoint')) {
        await db.execute(sql.raw(statement));
      }
      expect((await modelById('legacy'))?.input).toEqual(['text', 'image']);
      expect((await modelById('vision'))?.input).toEqual(['text', 'image']);
      expect((await modelById('other'))?.input).toEqual(['image']);
    }
    const [created] = await db
      .insert(schema.agentModels)
      .values({
        providerId: 'provider',
        modelId: 'new-default',
        name: 'New default',
      })
      .returning();
    expect(created.input).toEqual(['text', 'image']);
  });
});
