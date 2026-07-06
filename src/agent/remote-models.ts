/**
 * Build a pi-ai `Models` collection from the per-run model config the platform
 * sends in `run.start`. Runner-side counterpart of `build-models.ts`: no
 * database access, exactly one provider and one model — the credential scope
 * for a single run.
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
import type { RunModelConfig } from './protocol';

type ProviderApiType = RunModelConfig['apiType'];

/** The model picked for a run, in the shape the harness consumes. */
export type ResolvedModel = {
  providerId: string;
  providerName: string;
  apiType: ProviderApiType;
  model: Model<ProviderApiType>;
};

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

export function buildRunModels(config: RunModelConfig): {
  models: Models;
  picked: ResolvedModel;
} {
  const model: Model<ProviderApiType> = {
    id: config.model.id,
    name: config.model.name,
    api: config.apiType,
    provider: config.providerId,
    baseUrl: config.baseUrl,
    reasoning: config.model.reasoning,
    input: config.model.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.model.contextWindow,
    maxTokens: config.model.maxTokens,
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: config.providerId,
      name: config.providerName,
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: config.providerName,
          resolve: async () => ({
            auth: { apiKey: config.apiKey },
            source: 'hatch-run-config',
          }),
        },
      },
      models: [model],
      api: apiImpl(config.apiType),
    }),
  );

  return {
    models,
    picked: {
      providerId: config.providerId,
      providerName: config.providerName,
      apiType: config.apiType,
      model,
    },
  };
}
