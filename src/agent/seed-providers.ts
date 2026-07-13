/**
 * Server-only: seed the built-in provider templates. They intentionally have
 * no API keys and start disabled, so a fresh install never ships a shared
 * credential. Idempotent — does nothing if any provider exists.
 */
import { sql } from 'drizzle-orm';
import { db, schema } from '~/db';

/** Stable advisory-lock key that serializes default seeding ("SEED"). */
const SEED_LOCK_KEY = 0x53454544;

type SeedProvider = {
  name: string;
  apiType: schema.ProviderApiType;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
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
    name: 'OpenAI',
    apiType: 'openai-responses',
    // SDK appends `/responses`.
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabled: false,
    sortOrder: 0,
    models: [
      {
        modelId: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
      {
        modelId: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1050000,
        maxTokens: 128000,
      },
    ],
  },
  {
    name: 'Claude',
    apiType: 'anthropic-messages',
    // SDK appends `/v1/messages`.
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    enabled: false,
    sortOrder: 1,
    models: [
      {
        modelId: 'claude-fable-5',
        name: 'Claude Fable 5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        modelId: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        modelId: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1000000,
        maxTokens: 128000,
      },
    ],
  },
];

/** Insert the default providers/models when the providers table is empty. */
export async function seedDefaultProviders(): Promise<boolean> {
  // Serialize concurrent seeds (two requests hitting a fresh DB at once) so the
  // empty-table check and the inserts are atomic; otherwise both callers pass
  // the check and double-insert the defaults. A transaction-scoped advisory lock
  // makes the whole check+insert mutually exclusive and auto-releases on commit.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);

    const existing = await tx.query.agentProviders.findFirst();
    if (existing) return false;

    for (const def of DEFAULTS) {
      const [provider] = await tx
        .insert(schema.agentProviders)
        .values({
          name: def.name,
          apiType: def.apiType,
          baseUrl: def.baseUrl,
          apiKey: def.apiKey,
          enabled: def.enabled,
          sortOrder: def.sortOrder,
        })
        .returning();

      await tx.insert(schema.agentModels).values(
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
  });
}
