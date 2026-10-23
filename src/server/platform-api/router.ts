import { fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { AgentService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/agent_pb';
import { getAgentModelCatalog } from '~server/agent-model-catalog';
import { createAppHandoff, createHandoff } from '~server/handoffs';
import {
  insertAgentSession,
  listSessionSummaries,
  loadSessionDetail,
} from '~server/agent-session-store';
import { sessionOriginError } from '~server/session-http-auth';
import { sdkPayload } from './sdk';
import {
  createContextKey,
  type HandlerContext,
  type ConnectRouter,
} from '@connectrpc/connect';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { WorkflowService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/workflow_pb';
import { AuthService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/auth_pb';
import { SdkService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { publicApiError, publicError } from './errors';
import { db } from '~/db';
import { deployApp } from '~server/apps/deploy';
import {
  appMasterCommit,
  exportAppMasterBundle,
  stageAppBundleCheckout,
} from '~server/apps/git';
import { rollbackAppToVersion } from '~server/apps/manage';
import { createApp } from '~server/apps/scaffold';
import { deployWorkflow } from '~server/workflows/deploy';
import {
  exportWorkflowMasterBundle,
  stageWorkflowBundleCheckout,
  workflowMasterCommit,
} from '~server/workflows/git';
import { rollbackWorkflowToVersion } from '~server/workflows/manage';
import { createWorkflow } from '~server/workflows/scaffold';
import { authenticatePublicApi, type PublicApiContext } from './auth';
import { listAppsForAgent, getAppDetailForAgent } from '~server/apps/inspect';
import {
  listWorkflowsForAgent,
  getWorkflowDetailForAgent,
} from '~server/workflows/inspect';
import { projectAppManifestUrls } from '~server/apps/manifest';
import { projectWorkflowManifestUrls } from '~server/workflows/manifest';
import {
  appSummarySchema,
  workflowSummarySchema,
  appDetailSchema,
  workflowDetailSchema,
  appManifestViewSchema,
  workflowManifestViewSchema,
} from '~/platform-api/views';
import {
  queryAppKvRequestSchema,
  queryAppDataTableRequestSchema,
} from '~/platform-api/data-schemas';
import { queryAppKv } from '~server/apps/query-kv';
import { queryAppDataTable } from '~server/apps/query-data-table';
import { queryAppDatabase } from '~server/apps/query-db';
import { associateAgentSessionApp } from '~server/agent-session-apps';
import { WorkspaceService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/workspace_pb';
import { readWorkspace } from '~server/workspace-read';

export const publicApiContext = createContextKey<PublicApiContext>({
  run: null,
});
const columns = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
type Kind = 'apps' | 'workflows';

async function list(kind: Kind) {
  const rows =
    kind === 'apps'
      ? await db.query.apps.findMany({ columns })
      : await db.query.workflows.findMany({ columns });
  const summaries =
    kind === 'apps' ? await listAppsForAgent() : await listWorkflowsForAgent();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  return rows.flatMap((row) => {
    const summary = byId.get(row.id);
    if (!summary) return [];
    const view = {
      ...row,
      ...summary,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return [
      {
        ...project(row),
        view: jsonValue(
          (kind === 'apps' ? appSummarySchema : workflowSummarySchema).parse(
            view,
          ),
        ),
      },
    ];
  });
}
const jsonValue = (value: unknown) => fromJson(ValueSchema, value as JsonValue);
async function associate(id: string, context: HandlerContext) {
  const run = context.values.get(publicApiContext).run;
  if (!run) return { appId: id, association: 'not-applicable' };
  await associateAgentSessionApp(run.sessionId, id);
  return { appId: id, association: 'associated' };
}
function dataInput(
  value: Parameters<typeof toJson<typeof ValueSchema>>[1] | undefined,
) {
  if (!value) throw publicApiError('BAD_REQUEST');
  return toJson(ValueSchema, value);
}
async function dataOperation<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    throw publicError(error, true);
  }
}
function project(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'draft' | 'building' | 'deployed' | 'failed' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...row,
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function find(kind: Kind, id: string) {
  const lookup = (where: { id: string } | { slug: string }) =>
    kind === 'apps'
      ? db.query.apps.findFirst({ where, columns })
      : db.query.workflows.findFirst({ where, columns });
  const row = (await lookup({ id })) ?? (await lookup({ slug: id }));
  if (!row) throw publicApiError('NOT_FOUND');
  return row;
}
async function source(kind: Kind, id: string) {
  const row = await find(kind, id);
  if (kind === 'apps') {
    const bundle = await exportAppMasterBundle(row.id);
    return {
      id: row.id,
      masterCommit: (await appMasterCommit(row.id)) ?? undefined,
      bundle: bundle ?? undefined,
    };
  }
  const bundle = await exportWorkflowMasterBundle(row.id);
  return {
    id: row.id,
    masterCommit: (await workflowMasterCommit(row.id)) ?? undefined,
    bundle: bundle ?? undefined,
  };
}

function files(value: { files: { path: string; contentBase64: string }[] }) {
  return value.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, 'base64'),
  }));
}
function lifecycle(kind: Kind) {
  return {
    list: async () => ({ resources: await list(kind) }),
    create: async (
      input: {
        slug: string;
        name: string;
        description?: string;
        pin?: boolean;
      },
      context: HandlerContext,
    ) => {
      const { run } = context.values.get(publicApiContext);
      const created =
        kind === 'apps'
          ? await createApp(input, run ? { sessionId: run.sessionId } : {})
          : await createWorkflow(input);
      return { ...created, files: files(created) };
    },
    get: async (input: { id: string }) => {
      const row = await find(kind, input.id);
      const detail =
        kind === 'apps'
          ? await getAppDetailForAgent(row.id)
          : await getWorkflowDetailForAgent(row.id);
      if (!detail) throw publicApiError('NOT_FOUND');
      const view = (
        kind === 'apps' ? appDetailSchema : workflowDetailSchema
      ).parse({ ...detail, updatedAt: row.updatedAt.toISOString() });
      return { resource: { ...project(row), view: jsonValue(view) } };
    },
    source: async (input: { id: string }) => ({
      source: await source(kind, input.id),
    }),
    deploy: async (
      input: {
        id: string;
        message: string;
        generation: string;
        bundle: Uint8Array;
        allowDestructiveDataMigration?: boolean;
        dataMigrationApprovalToken?: string;
      },
      context: HandlerContext,
    ) => {
      const row = await find(kind, input.id);
      if (kind === 'apps') await associate(row.id, context);
      if (input.generation !== row.createdAt.toISOString())
        throw publicApiError('RESOURCE_GENERATION_CONFLICT');
      const staged =
        kind === 'apps'
          ? await stageAppBundleCheckout(row.id, Buffer.from(input.bundle))
          : await stageWorkflowBundleCheckout(
              row.id,
              Buffer.from(input.bundle),
            );
      try {
        const options = {
          message: input.message,
          allowDestructiveDataMigration: input.allowDestructiveDataMigration,
          dataMigrationApprovalToken: input.dataMigrationApprovalToken,
          sourceDir: staged.dir,
          expectedGeneration: input.generation,
        };
        const result =
          kind === 'apps'
            ? await deployApp(row.id, options)
            : await deployWorkflow(row.id, options);
        const released = await find(kind, row.id);
        const normalized =
          kind === 'apps'
            ? appManifestViewSchema.parse(
                projectAppManifestUrls(
                  result.normalized as Parameters<
                    typeof projectAppManifestUrls
                  >[0],
                  row.id,
                  released.slug,
                ),
              )
            : workflowManifestViewSchema.parse(
                projectWorkflowManifestUrls(
                  result.normalized as Parameters<
                    typeof projectWorkflowManifestUrls
                  >[0],
                  row.id,
                ),
              );
        return {
          deployment: {
            deploymentId: result.deploymentId,
            version: result.version,
            compatibilityVersion: result.compatibilityVersion,
            slug: kind === 'apps' ? released.slug : undefined,
            normalized: jsonValue(normalized),
          },
        };
      } finally {
        await staged.cleanup();
      }
    },
    rollback: async (
      input: { id: string; version: number },
      context: HandlerContext,
    ) => {
      const row = await find(kind, input.id);
      if (kind === 'apps') await associate(row.id, context);
      const restored =
        kind === 'apps'
          ? await rollbackAppToVersion(row.id, input.version)
          : await rollbackWorkflowToVersion(row.id, input.version);
      return { restored };
    },
  };
}

export function registerPlatformApi(
  router: ConnectRouter,
  deployBodyLimit: number,
) {
  // Override only the interactive methods' gate. Their origin/credential boundary
  // must remain stricter than the platform-authority lifecycle RPCs.
  const sessionOnly = {
    grpc: false,
    grpcWeb: false,
    requestGate: async (context: HandlerContext) => {
      try {
        const request = new Request(context.url, {
          headers: context.requestHeader,
        });
        if (sessionOriginError(request)) throw publicApiError('FORBIDDEN');
        const auth = await authenticatePublicApi(request);
        if (auth.status?.credentialType !== 'session' || !auth.session)
          throw publicApiError('SESSION_REQUIRED');
        context.values.set(publicApiContext, auth);
      } catch (error) {
        throw publicError(error);
      }
    },
  };
  router.service(
    WorkspaceService,
    { getWorkspace: () => readWorkspace() },
    sessionOnly,
  );
  router.service(
    AgentService,
    {
      getModelCatalog: async () => {
        const catalog = await getAgentModelCatalog();
        return { ...catalog, defaultModel: catalog.defaultModel ?? undefined };
      },
      listSessions: async (input) => ({
        sessions: (await listSessionSummaries(input)).map((session) => ({
          ...session,
          providerId: session.providerId ?? undefined,
          modelId: session.modelId ?? undefined,
        })),
      }),
      createSession: (input) => insertAgentSession(input),
      getSession: async (input) => {
        const session = await loadSessionDetail(input.id);
        if (!session) throw publicApiError('NOT_FOUND');
        const active = session.activeRun;
        return {
          session: {
            ...session,
            providerId: session.providerId ?? undefined,
            modelId: session.modelId ?? undefined,
            messages: session.messages.map((message) =>
              fromJson(ValueSchema, message),
            ),
            activeRun: active
              ? {
                  ...active,
                  userTurn: active.userTurn ?? undefined,
                  pendingAsk: active.pendingAsk ?? undefined,
                  answeredAskId: active.answeredAskId ?? undefined,
                  pendingEnvRequest: active.pendingEnvRequest ?? undefined,
                }
              : undefined,
            runs: session.runs.map((run) => ({
              ...run,
              completedAt: run.completedAt ?? undefined,
              error: run.error ?? undefined,
            })),
          },
        };
      },
    },
    sessionOnly,
  );
  router.rpc(
    AuthService.method.createHandoff,
    (_input, context) => {
      return createHandoff(
        new Request(context.url, { headers: context.requestHeader }),
        context.values.get(publicApiContext).session!,
      );
    },
    { ...sessionOnly, jsonOptions: { ignoreUnknownFields: false } },
  );
  router.rpc(
    AppService.method.createAppHandoff,
    async (input, context) => {
      const app = await find('apps', input.id);
      return createAppHandoff(
        new Request(context.url, { headers: context.requestHeader }),
        context.values.get(publicApiContext).session!,
        app.id,
      );
    },
    sessionOnly,
  );
  const apps = lifecycle('apps');
  const workflows = lifecycle('workflows');
  router.rpc(
    AppService.method.associateAppSession,
    async (input, context) =>
      associate((await find('apps', input.id)).id, context),
    { jsonOptions: { ignoreUnknownFields: false } },
  );
  router.rpc(
    AppService.method.queryAppKv,
    async (input) =>
      dataOperation(async () => {
        const parsed = queryAppKvRequestSchema.safeParse(
          dataInput(input.input),
        );
        if (!parsed.success) throw publicApiError('BAD_REQUEST');
        return {
          result: jsonValue(
            await queryAppKv((await find('apps', input.id)).id, parsed.data),
          ),
        };
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(
    AppService.method.queryAppDataTable,
    async (input, context) =>
      dataOperation(async () => {
        context.signal.throwIfAborted();
        const parsed = queryAppDataTableRequestSchema.safeParse(
          dataInput(input.input),
        );
        if (!parsed.success) throw publicApiError('BAD_REQUEST');
        const row = await find('apps', input.id);
        context.signal.throwIfAborted();
        return {
          result: jsonValue(
            await queryAppDataTable(row.id, parsed.data, context.signal),
          ),
        };
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(
    AppService.method.queryAppDb,
    async (input, context) =>
      dataOperation(async () => {
        context.signal.throwIfAborted();
        const row = await find('apps', input.id);
        context.signal.throwIfAborted();
        return queryAppDatabase(row.id, input.sql, context.signal);
      }),
    { readMaxBytes: deployBodyLimit },
  );
  router.rpc(AppService.method.listApps, apps.list);
  router.rpc(AppService.method.createApp, apps.create);
  router.rpc(AppService.method.getApp, apps.get);
  router.rpc(AppService.method.getAppSource, apps.source);
  router.rpc(AppService.method.rollbackApp, apps.rollback);
  router.rpc(AppService.method.deployApp, apps.deploy, {
    readMaxBytes: deployBodyLimit,
  });
  router.rpc(WorkflowService.method.listWorkflows, workflows.list);
  router.rpc(WorkflowService.method.createWorkflow, workflows.create);
  router.rpc(WorkflowService.method.getWorkflow, workflows.get);
  router.rpc(WorkflowService.method.getWorkflowSource, workflows.source);
  router.rpc(WorkflowService.method.rollbackWorkflow, workflows.rollback);
  router.rpc(WorkflowService.method.deployWorkflow, workflows.deploy, {
    readMaxBytes: deployBodyLimit,
  });
  router.rpc(AuthService.method.getStatus, (_input, context) => {
    const status = context.values.get(publicApiContext).status;
    if (!status) throw publicApiError('UNAUTHORIZED');
    const expiresAt = status.expiresAt ?? undefined;
    if (status.credentialType === 'session')
      return {
        expiresAt,
        credential: { case: 'session', value: { user: status.user } },
      };
    if (status.credentialType === 'api-key')
      return {
        expiresAt,
        credential: {
          case: 'apiKey',
          value: {
            user: status.user,
            id: status.key.id,
            name: status.key.name ?? undefined,
          },
        },
      };
    return { expiresAt, credential: { case: 'run', value: status.context } };
  });
  router.service(SdkService, {
    getSdk: async (input) => {
      // The interceptor validates the closed set before any domain access.
      const result = await sdkPayload(input.kind as 'app' | 'workflow');
      return { files: files(result), tooling: result.tooling };
    },
  });
}
