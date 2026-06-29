import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import type { ProviderApiType } from '~/db/schema';
import { authMiddleware } from './auth';

const apiTypeSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
]);

export type ProviderModel = {
  id: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  enabled: boolean;
  sortOrder: number;
};

export type ProviderWithModels = {
  id: string;
  name: string;
  apiType: ProviderApiType;
  baseUrl: string;
  enabled: boolean;
  sortOrder: number;
  models: ProviderModel[];
};

/**
 * List providers with their models. Seeds defaults on first run. API keys are
 * never returned to the client — not even a masked fragment.
 */
export const listProviders = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<ProviderWithModels[]> => {
    const { seedDefaultProviders } = await import('~agent/seed-providers');
    await seedDefaultProviders();

    const providers = await db.query.agentProviders.findMany({
      orderBy: (p, { asc }) => [asc(p.sortOrder), asc(p.createdAt)],
    });

    const result: ProviderWithModels[] = [];
    for (const p of providers) {
      const models = await db.query.agentModels.findMany({
        where: (m, { eq: e }) => e(m.providerId, p.id),
        orderBy: (m, { asc }) => [asc(m.sortOrder), asc(m.createdAt)],
      });
      result.push({
        id: p.id,
        name: p.name,
        apiType: p.apiType,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        sortOrder: p.sortOrder,
        models: models.map((m) => ({
          id: m.id,
          modelId: m.modelId,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          input: m.input,
          enabled: m.enabled,
          sortOrder: m.sortOrder,
        })),
      });
    }
    return result;
  });

const createProviderSchema = z.object({
  name: z.string().min(1),
  apiType: apiTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
});

export const createProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createProviderSchema>) =>
    createProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const [row] = await db
      .insert(schema.agentProviders)
      .values({
        name: data.name,
        apiType: data.apiType,
        baseUrl: data.baseUrl.trim(),
        apiKey: data.apiKey.trim(),
      })
      .returning();
    return { id: row.id };
  });

const updateProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  apiType: apiTypeSchema.optional(),
  baseUrl: z.string().min(1).optional(),
  /** Empty string means "keep existing key". */
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const updateProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateProviderSchema>) =>
    updateProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const patch: Partial<typeof schema.agentProviders.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.apiType !== undefined) patch.apiType = data.apiType;
    if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl.trim();
    // Trim first so a whitespace-only value keeps the existing key instead of
    // silently wiping it.
    const trimmedKey = data.apiKey?.trim();
    if (trimmedKey) patch.apiKey = trimmedKey;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    await db
      .update(schema.agentProviders)
      .set(patch)
      .where(eq(schema.agentProviders.id, data.id));
    return { ok: true };
  });

export const deleteProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await db
      .delete(schema.agentProviders)
      .where(eq(schema.agentProviders.id, data.id));
    return { ok: true };
  });

const createModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean().default(false),
  contextWindow: z.number().int().positive().default(128000),
  maxTokens: z.number().int().positive().default(8192),
  input: z.array(z.string()).default(['text']),
});

export const createModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createModelSchema>) =>
    createModelSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const [row] = await db
      .insert(schema.agentModels)
      .values({
        providerId: data.providerId,
        modelId: data.modelId.trim(),
        name: data.name,
        reasoning: data.reasoning,
        contextWindow: data.contextWindow,
        maxTokens: data.maxTokens,
        input: data.input,
      })
      .returning();
    return { id: row.id };
  });

const updateModelSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const updateModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateModelSchema>) =>
    updateModelSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const patch: Partial<typeof schema.agentModels.$inferInsert> = {};
    if (data.modelId !== undefined) patch.modelId = data.modelId.trim();
    if (data.name !== undefined) patch.name = data.name;
    if (data.reasoning !== undefined) patch.reasoning = data.reasoning;
    if (data.contextWindow !== undefined)
      patch.contextWindow = data.contextWindow;
    if (data.maxTokens !== undefined) patch.maxTokens = data.maxTokens;

    await db
      .update(schema.agentModels)
      .set(patch)
      .where(eq(schema.agentModels.id, data.id));
    return { ok: true };
  });

export const deleteModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await db
      .delete(schema.agentModels)
      .where(eq(schema.agentModels.id, data.id));
    return { ok: true };
  });
