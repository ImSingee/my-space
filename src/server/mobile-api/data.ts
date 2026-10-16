import { db } from '~/db';
import { appCompatibility } from '~/app-compatibility';

const appColumns = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  capabilities: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Explicit projections keep webhook/provider secrets out of native responses. */
export async function listMobileApps() {
  const apps = await db.query.apps.findMany({
    columns: appColumns,
    orderBy: { updatedAt: 'desc' },
  });
  return apps.map((app) => ({
    ...app,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  }));
}

export async function getMobileApp(id: string) {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { ...appColumns, currentDeploymentId: true },
  });
  if (!app) return null;
  const { currentDeploymentId, ...details } = app;
  const deployment = currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: currentDeploymentId },
        columns: { compatibilityVersion: true },
      })
    : null;
  return {
    ...details,
    deploymentRevision: currentDeploymentId,
    compatibility: deployment
      ? appCompatibility(deployment.compatibilityVersion)
      : null,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export async function getMobileConfig() {
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
          input: true,
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
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
    }))
    .filter((provider) => provider.models.length > 0);
  const first = configured[0];
  return {
    apiVersion: 1 as const,
    providers: configured,
    defaultModel: first
      ? { providerId: first.id, modelId: first.models[0].modelId }
      : null,
  };
}
