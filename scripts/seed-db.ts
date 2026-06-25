import { db, schema } from '../src/db';

const TEST_KEY = 'sk-e2f9188df87094bccc63a144cbd809d3';

const DEFAULTS = [
  {
    name: 'Singee Anthropic',
    apiType: 'anthropic-messages' as const,
    baseUrl: 'https://ai.singee.me/test',
    apiKey: TEST_KEY,
    sortOrder: 0,
    models: [
      {
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  },
  {
    name: 'Singee OpenAI',
    apiType: 'openai-responses' as const,
    baseUrl: 'https://ai.singee.me/test/v1',
    apiKey: TEST_KEY,
    sortOrder: 1,
    models: [
      {
        modelId: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        contextWindow: 400000,
        maxTokens: 16384,
      },
    ],
  },
];

async function main() {
  const existing = await db.query.agentProviders.findFirst();
  if (existing) {
    console.log('Providers already exist, skipping seed.');
    process.exit(0);
  }

  for (const def of DEFAULTS) {
    const [provider] = await db
      .insert(schema.agentProviders)
      .values({
        name: def.name,
        apiType: def.apiType,
        baseUrl: def.baseUrl,
        apiKey: def.apiKey,
        sortOrder: def.sortOrder,
      })
      .returning();

    await db.insert(schema.agentModels).values(
      def.models.map((m, index) => ({
        providerId: provider.id,
        modelId: m.modelId,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: ['text'],
        sortOrder: index,
      })),
    );
    console.log(
      `Seeded provider ${def.name} with ${def.models.length} model(s)`,
    );
  }

  console.log('Finished seeding default providers.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
