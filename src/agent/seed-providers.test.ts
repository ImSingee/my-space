import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { seedDefaultProviders } = await import('./seed-providers');

beforeEach(async () => {
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
});

describe('seedDefaultProviders', () => {
  it('seeds disabled official providers with empty keys and current models', async () => {
    await expect(seedDefaultProviders()).resolves.toBe(true);

    const providers = await db.query.agentProviders.findMany({
      orderBy: (provider, { asc: ascending }) => [
        ascending(provider.sortOrder),
      ],
    });
    expect(
      providers.map(
        ({ name, apiType, baseUrl, apiKey, enabled, sortOrder }) => ({
          name,
          apiType,
          baseUrl,
          apiKey,
          enabled,
          sortOrder,
        }),
      ),
    ).toEqual([
      {
        name: 'OpenAI',
        apiType: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        enabled: false,
        sortOrder: 0,
      },
      {
        name: 'Claude',
        apiType: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        enabled: false,
        sortOrder: 1,
      },
    ]);

    const models = await db
      .select({
        providerName: schema.agentProviders.name,
        modelId: schema.agentModels.modelId,
        name: schema.agentModels.name,
        reasoning: schema.agentModels.reasoning,
        input: schema.agentModels.input,
        contextWindow: schema.agentModels.contextWindow,
        maxTokens: schema.agentModels.maxTokens,
        sortOrder: schema.agentModels.sortOrder,
      })
      .from(schema.agentModels)
      .innerJoin(
        schema.agentProviders,
        eq(schema.agentModels.providerId, schema.agentProviders.id),
      )
      .orderBy(
        asc(schema.agentProviders.sortOrder),
        asc(schema.agentModels.sortOrder),
      );
    expect(models).toEqual([
      {
        providerName: 'OpenAI',
        modelId: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        sortOrder: 0,
      },
      {
        providerName: 'OpenAI',
        modelId: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        sortOrder: 1,
      },
      {
        providerName: 'Claude',
        modelId: 'claude-fable-5',
        name: 'Claude Fable 5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        sortOrder: 0,
      },
      {
        providerName: 'Claude',
        modelId: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        sortOrder: 1,
      },
      {
        providerName: 'Claude',
        modelId: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        sortOrder: 2,
      },
    ]);
  });

  it('is idempotent after the defaults have been seeded', async () => {
    await expect(seedDefaultProviders()).resolves.toBe(true);
    await expect(seedDefaultProviders()).resolves.toBe(false);

    await expect(db.$count(schema.agentProviders)).resolves.toBe(2);
    await expect(db.$count(schema.agentModels)).resolves.toBe(5);
  });

  it('does not seed when any provider already exists', async () => {
    await db.insert(schema.agentProviders).values({
      name: 'Custom',
      apiType: 'openai-responses',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'custom-key',
    });

    await expect(seedDefaultProviders()).resolves.toBe(false);
    await expect(db.$count(schema.agentProviders)).resolves.toBe(1);
    await expect(db.$count(schema.agentModels)).resolves.toBe(0);
  });
});
