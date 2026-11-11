/** Normalize Protobuf presence for the existing UI without importing server code. */
import { toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type {
  Resource,
  AgentSession,
  AgentSessionSummary,
  GetModelCatalogResponse,
} from '@hatch/platform-api';
import { MobileError } from './security';
import type {
  AppSummary,
  AgentModelCatalog,
  RunStatus,
  SessionDetail,
  SessionSummary,
} from './types';

export function appProjection(app: Resource): AppSummary {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description ?? null,
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}
export function summaryProjection(
  session: AgentSessionSummary,
): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    appIds: session.appIds,
    providerId: session.providerId ?? null,
    modelId: session.modelId ?? null,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
  };
}
function runStatus(value: string): RunStatus {
  switch (value) {
    case 'running':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return value;
    default:
      throw new MobileError(
        'invalid_response',
        'The instance returned an unsupported run status.',
      );
  }
}
export function sessionProjection(session: AgentSession): SessionDetail {
  const active = session.activeRun;
  return {
    id: session.id,
    title: session.title,
    appIds: session.appIds,
    providerId: session.providerId ?? null,
    modelId: session.modelId ?? null,
    updatedAt: session.updatedAt,
    serverTime: session.serverTime,
    messages: session.messages.map((message) => toJson(ValueSchema, message)),
    activeRun: active
      ? {
          id: active.id,
          status: runStatus(active.status),
          startedAt: active.startedAt,
          userTurn: active.userTurn ?? null,
          pendingAsk: active.pendingAsk
            ? {
                askId: active.pendingAsk.askId,
                questions: active.pendingAsk.questions.map((question) => ({
                  id: question.id,
                  prompt: question.prompt,
                  allowMultiple: question.allowMultiple,
                  options: question.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                  })),
                })),
              }
            : null,
          answeredAskId: active.answeredAskId ?? null,
          pendingEnvRequest: active.pendingEnvRequest
            ? {
                requestId: active.pendingEnvRequest.requestId,
                reason: active.pendingEnvRequest.reason,
                variables: active.pendingEnvRequest.variables.map(
                  (variable) => ({
                    key: variable.key,
                    description: variable.description,
                    secret: variable.secret,
                  }),
                ),
              }
            : null,
        }
      : null,
    runs: session.runs.map((run) => ({
      id: run.id,
      status: runStatus(run.status),
      userTurn: run.userTurn,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
      error: run.error ?? null,
    })),
  };
}
export function catalogProjection(
  catalog: GetModelCatalogResponse,
): AgentModelCatalog {
  return {
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        modelId: model.modelId,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    })),
    defaultModel: catalog.defaultModel
      ? {
          providerId: catalog.defaultModel.providerId,
          modelId: catalog.defaultModel.modelId,
        }
      : null,
  };
}
