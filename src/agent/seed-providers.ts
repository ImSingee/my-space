/**
 * Server-only: seed the built-in `ai.singee.me` test providers so the platform
 * is usable out of the box. Idempotent — does nothing if any provider exists.
 */
import { db, schema } from '~/db';

const TEST_KEY = 'sk-e2f9188df87094bccc63a144cbd809d3';

type SeedProvider = {
  name: string;
  apiType: schema.ProviderApiType;
  baseUrl: string;
  apiKey: string;
  sortOrder: number;
  models: Array<{
    modelId: string;
    name: string;
    reasoning: boolean;
    input: Array<'text' | 'image'>;
    contextWindow: number;
    maxTokens: number;
  }>;
};

const DEFAULTS: SeedProvider[] = [
  {
    name: 'Singee Anthropic',
    apiType: 'anthropic-messages',
    // SDK appends `/v1/messages`.
    baseUrl: 'https://ai.singee.me/test',
    apiKey: TEST_KEY,
    sortOrder: 0,
    models: [
      {
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  },
  {
    name: 'Singee OpenAI',
    apiType: 'openai-responses',
    // SDK appends `/responses`.
    baseUrl: 'https://ai.singee.me/test/v1',
    apiKey: TEST_KEY,
    sortOrder: 1,
    models: [
      {
        modelId: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 400000,
        maxTokens: 16384,
      },
    ],
  },
];

/** Insert the default providers/models when the providers table is empty. */
export async function seedDefaultProviders(): Promise<boolean> {
  const existing = await db.query.agentProviders.findFirst();
  if (existing) return false;

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
        input: m.input,
        sortOrder: index,
      })),
    );
  }

  return true;
}
