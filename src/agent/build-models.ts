/**
 * Server-only: build a pi-ai `Models` collection from the providers/models that
 * the user configured in the platform database. Auth (the API key) is resolved
 * per request from the stored provider row, so keys never leave the server.
 *
 * Only import this from server-function handlers or API route handlers.
 */
import {
  createModels,
  createProvider,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { db } from '~/db';
import type { ProviderApiType } from '~/db/schema';

function apiImpl(apiType: ProviderApiType) {
  switch (apiType) {
    case 'anthropic-messages':
      return anthropicMessagesApi();
    case 'openai-responses':
      return openAIResponsesApi();
    case 'openai-completions':
      return openAICompletionsApi();
  }
}

export type ResolvedModel = {
  providerId: string;
  providerName: string;
  apiType: ProviderApiType;
  model: Model<ProviderApiType>;
};

/** Build the runtime `Models` plus a flat list of selectable models. */
export async function loadAgentModels(): Promise<{
  models: Models;
  list: ResolvedModel[];
}> {
  const providers = await db.query.agentProviders.findMany({
    where: (p, { eq }) => eq(p.enabled, true),
    orderBy: (p, { asc }) => [asc(p.sortOrder), asc(p.createdAt)],
  });

  const models = createModels();
  const list: ResolvedModel[] = [];

  for (const provider of providers) {
    const modelRows = await db.query.agentModels.findMany({
      where: (m, { eq, and }) =>
        and(eq(m.providerId, provider.id), eq(m.enabled, true)),
      orderBy: (m, { asc }) => [asc(m.sortOrder), asc(m.createdAt)],
    });
    if (modelRows.length === 0) continue;

    const piModels: Model<ProviderApiType>[] = modelRows.map((m) => ({
      id: m.modelId,
      name: m.name,
      api: provider.apiType,
      provider: provider.id,
      baseUrl: provider.baseUrl,
      reasoning: m.reasoning,
      input: m.input as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));

    models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        auth: {
          apiKey: {
            name: provider.name,
            resolve: async () => ({
              auth: { apiKey: provider.apiKey },
              source: 'hatch-config',
            }),
          },
        },
        models: piModels,
        api: apiImpl(provider.apiType),
      }),
    );

    for (const model of piModels) {
      list.push({
        providerId: provider.id,
        providerName: provider.name,
        apiType: provider.apiType,
        model,
      });
    }
  }

  return { models, list };
}

/** Pick the requested model, falling back to the first available one. */
export function pickModel(
  list: ResolvedModel[],
  providerId?: string | null,
  modelId?: string | null,
): ResolvedModel | undefined {
  if (providerId && modelId) {
    const exact = list.find(
      (r) => r.providerId === providerId && r.model.id === modelId,
    );
    if (exact) return exact;
  }
  return list[0];
}
