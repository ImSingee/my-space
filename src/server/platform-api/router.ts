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
import { publicApiError } from './errors';
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
import type { PublicApiContext } from './auth';

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
  return rows.map(project);
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
    get: async (input: { id: string }) => ({
      resource: project(await find(kind, input.id)),
    }),
    source: async (input: { id: string }) => ({
      source: await source(kind, input.id),
    }),
    deploy: async (input: {
      id: string;
      message: string;
      generation: string;
      bundle: Uint8Array;
      allowDestructiveDataMigration?: boolean;
      dataMigrationApprovalToken?: string;
    }) => {
      const row = await find(kind, input.id);
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
        const deploy = kind === 'apps' ? deployApp : deployWorkflow;
        const result = await deploy(row.id, {
          message: input.message,
          allowDestructiveDataMigration: input.allowDestructiveDataMigration,
          dataMigrationApprovalToken: input.dataMigrationApprovalToken,
          sourceDir: staged.dir,
          expectedGeneration: input.generation,
        });
        return {
          deployment: {
            deploymentId: result.deploymentId,
            version: result.version,
            compatibilityVersion: result.compatibilityVersion,
          },
        };
      } finally {
        await staged.cleanup();
      }
    },
    rollback: async (input: { id: string; version: number }) => {
      const row = await find(kind, input.id);
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
  const apps = lifecycle('apps');
  const workflows = lifecycle('workflows');
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
  router.service(AuthService, {
    getStatus: (_input, context) => {
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
    },
  });
  router.service(SdkService, {
    getSdk: async (input) => {
      // The interceptor validates the closed set before any domain access.
      const result = await sdkPayload(input.kind as 'app' | 'workflow');
      return { files: files(result), tooling: result.tooling };
    },
  });
}
