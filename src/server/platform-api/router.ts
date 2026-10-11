import { sdkPayload } from './sdk';
import { implement, ORPCError } from '@orpc/server';
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
import { platformApiContract } from '~/platform-api/contract';
import type { PublicApiContext } from './auth';

const api = implement(platformApiContract).$context<PublicApiContext>();
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
  if (!row) throw new ORPCError('NOT_FOUND');
  return row;
}
async function source(kind: Kind, id: string) {
  const row = await find(kind, id);
  if (kind === 'apps') {
    const bundle = await exportAppMasterBundle(row.id);
    return {
      id: row.id,
      masterCommit: await appMasterCommit(row.id),
      bundleBase64: bundle?.toString('base64') ?? null,
    };
  }
  const bundle = await exportWorkflowMasterBundle(row.id);
  return {
    id: row.id,
    masterCommit: await workflowMasterCommit(row.id),
    bundleBase64: bundle?.toString('base64') ?? null,
  };
}

export const platformApiRouter = api.router({
  auth: {
    status: api.auth.status.handler(({ context }) => {
      if (!context.status) throw new ORPCError('UNAUTHORIZED');
      return context.status;
    }),
  },
  sdk: { get: api.sdk.get.handler(({ input }) => sdkPayload(input.kind)) },
  apps: {
    list: api.apps.list.handler(() => list('apps')),
    create: api.apps.create.handler(async ({ input, context }) => {
      return createApp(
        input,
        context.run ? { sessionId: context.run.sessionId } : {},
      );
    }),
    get: api.apps.get.handler(async ({ input }) =>
      project(await find('apps', input.id)),
    ),
    source: api.apps.source.handler(({ input }) => source('apps', input.id)),
    deploy: api.apps.deploy.handler(async ({ input }) => {
      const row = await find('apps', input.params.id);
      const body = input.body;
      if (body.generation !== row.createdAt.toISOString())
        throw new ORPCError('RESOURCE_GENERATION_CONFLICT', { status: 409 });
      const staged = await stageAppBundleCheckout(
        row.id,
        Buffer.from(body.bundleBase64, 'base64'),
      );
      try {
        const result = await deployApp(row.id, {
          ...body,
          sourceDir: staged.dir,
          expectedGeneration: body.generation,
        });
        return {
          deploymentId: result.deploymentId,
          version: result.version,
          compatibilityVersion: result.compatibilityVersion,
        };
      } finally {
        await staged.cleanup();
      }
    }),
    rollback: api.apps.rollback.handler(async ({ input }) => {
      const row = await find('apps', input.params.id);
      return rollbackAppToVersion(row.id, input.body.version);
    }),
  },
  workflows: {
    list: api.workflows.list.handler(() => list('workflows')),
    create: api.workflows.create.handler(async ({ input }) => {
      return createWorkflow(input);
    }),
    get: api.workflows.get.handler(async ({ input }) =>
      project(await find('workflows', input.id)),
    ),
    source: api.workflows.source.handler(({ input }) =>
      source('workflows', input.id),
    ),
    deploy: api.workflows.deploy.handler(async ({ input }) => {
      const row = await find('workflows', input.params.id);
      const body = input.body;
      if (body.generation !== row.createdAt.toISOString())
        throw new ORPCError('RESOURCE_GENERATION_CONFLICT', { status: 409 });
      const staged = await stageWorkflowBundleCheckout(
        row.id,
        Buffer.from(body.bundleBase64, 'base64'),
      );
      try {
        const result = await deployWorkflow(row.id, {
          ...body,
          sourceDir: staged.dir,
          expectedGeneration: body.generation,
        });
        return {
          deploymentId: result.deploymentId,
          version: result.version,
          compatibilityVersion: result.compatibilityVersion,
        };
      } finally {
        await staged.cleanup();
      }
    }),
    rollback: api.workflows.rollback.handler(async ({ input }) => {
      const row = await find('workflows', input.params.id);
      return rollbackWorkflowToVersion(row.id, input.body.version);
    }),
  },
});
