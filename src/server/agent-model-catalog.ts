import { db } from '~/db';

export async function getAgentModelCatalog() {
  const providers = await db.query.agentProviders.findMany({
    where: { enabled: true },
    columns: { id: true, name: true },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  const models = providers.length
    ? await db.query.agentModels.findMany({
        where: {
          enabled: true,
          providerId: { in: providers.map((provider) => provider.id) },
        },
        columns: {
          providerId: true,
          id: true,
          modelId: true,
          name: true,
          reasoning: true,
          contextWindow: true,
          maxTokens: true,
        },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      })
    : [];
  const configured = providers
    .map((provider) => ({
      ...provider,
      models: models
        .filter((model) => model.providerId === provider.id)
        .map((model) => ({
          id: model.id,
          modelId: model.modelId,
          name: model.name,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
    }))
    .filter((provider) => provider.models.length > 0);
  const first = configured[0];
  return {
    providers: configured,
    defaultModel: first
      ? { providerId: first.id, modelId: first.models[0].modelId }
      : null,
  };
}
