/** Public lifecycle guard. Data, secrets, users and Runner control are never routed here. */
import { z } from 'zod';
import { db } from '~/db';
import type { CliScope } from '~auth/cli-policy';
import { AuthError, requirePermission, resolveCredential } from './credentials';
import { safeJson, readAuthBody } from './http';
import { withCliOperation } from './operation';
import {
  createAppRequestSchema,
  createWorkflowRequestSchema,
  deploySourceRequestSchema,
  rollbackRequestSchema,
} from '~agent/protocol';

export async function handleLifecycleRequest(request: Request, path: string[]) {
  const principal = await resolveCredential(request);
  if (!['apps', 'workflows'].includes(path[0]) || path.length > 3)
    throw new AuthError('not_found', 404);
  const kind = path[0] === 'apps' ? 'app' : 'workflow';
  const action = path[2];
  const scope =
    `${kind}.${action === 'source' ? 'source.read' : action === 'deploy' || action === 'rollback' ? action : request.method === 'POST' && path.length === 1 ? 'create' : 'read'}` as CliScope;
  if (
    !['GET', 'POST'].includes(request.method) ||
    (action && !['source', 'deploy', 'rollback'].includes(action)) ||
    (request.method === 'GET' && action && action !== 'source') ||
    (request.method === 'POST' &&
      path.length > 1 &&
      !['deploy', 'rollback'].includes(action ?? ''))
  )
    throw new AuthError('not_found', 404);
  requirePermission(principal, scope);
  if (request.method === 'POST' && path.length === 1) {
    const raw = await readAuthBody(request);
    return safeJson(
      await withCliOperation(principal, scope, undefined, async () => {
        if (kind === 'app') {
          const input = createAppRequestSchema.strict().parse(raw);
          const { createApp } = await import('~server/apps/scaffold');
          return createApp(
            input,
            principal.context ? { sessionId: principal.context.sessionId } : {},
          );
        }
        const input = createWorkflowRequestSchema.strict().parse(raw);
        const { createWorkflow } = await import('~server/workflows/scaffold');
        return createWorkflow(input);
      }),
    );
  }
  // Return minimal inventory metadata; internal Agent inspection includes webhook
  // credentials and workflow execution data and cannot be reused on public APIs.
  if (path.length === 1) {
    const ids =
      principal.resources.mode === 'ids'
        ? principal.resources[path[0] as 'apps' | 'workflows']
        : undefined;
    const columns = {
      id: true,
      slug: true,
      name: true,
      description: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    } as const;
    const rows =
      ids?.length === 0
        ? []
        : kind === 'app'
          ? await db.query.apps.findMany({
              where: ids ? { id: { in: ids } } : undefined,
              columns,
            })
          : await db.query.workflows.findMany({
              where: ids ? { id: { in: ids } } : undefined,
              columns,
            });
    return safeJson(rows);
  }
  const id = z.string().min(1).max(191).parse(decodeURIComponent(path[1]));
  const columns = {
    id: true,
    slug: true,
    name: true,
    description: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  } as const;
  // An exact immutable ID always wins. Legacy kebab-case IDs share the slug
  // alphabet, so another object's slug may equal this ID.
  const find = (where: { id: string } | { slug: string }) =>
    kind === 'app'
      ? db.query.apps.findFirst({ where, columns })
      : db.query.workflows.findFirst({ where, columns });
  const row = (await find({ id })) ?? (await find({ slug: id }));
  if (!row) throw new AuthError('resource_not_found', 404);
  requirePermission(principal, scope, row.id);
  if (request.method === 'POST') {
    return safeJson(
      await withCliOperation(principal, scope, row.id, async () => {
        if (action === 'rollback') {
          const { version } = rollbackRequestSchema
            .strict()
            .parse(await readAuthBody(request));
          if (kind === 'app') {
            const { rollbackAppToVersion } =
              await import('~server/apps/manage');
            return rollbackAppToVersion(row.id, version);
          }
          const { rollbackWorkflowToVersion } =
            await import('~server/workflows/manage');
          return rollbackWorkflowToVersion(row.id, version);
        }
        const body = deploySourceRequestSchema
          .strict()
          .parse(await readAuthBody(request, 256 * 1024 * 1024));
        if (body.generation !== row.createdAt.toISOString())
          throw new AuthError('resource_generation_conflict', 409);
        if (kind === 'app') {
          const { stageAppBundleCheckout } = await import('~server/apps/git');
          const staged = await stageAppBundleCheckout(
            row.id,
            Buffer.from(body.bundleBase64, 'base64'),
          );
          try {
            const { deployApp } = await import('~server/apps/deploy');
            const result = await deployApp(row.id, {
              ...body,
              sourceDir: staged.dir,
            });
            return {
              deploymentId: result.deploymentId,
              version: result.version,
              compatibilityVersion: result.compatibilityVersion,
            };
          } finally {
            await staged.cleanup();
          }
        }
        const { stageWorkflowBundleCheckout } =
          await import('~server/workflows/git');
        const staged = await stageWorkflowBundleCheckout(
          row.id,
          Buffer.from(body.bundleBase64, 'base64'),
        );
        try {
          const { deployWorkflow } = await import('~server/workflows/deploy');
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
    );
  }
  if (!action) return safeJson(row);
  const git =
    kind === 'app'
      ? await import('~server/apps/git')
      : await import('~server/workflows/git');
  const bundle =
    'exportAppMasterBundle' in git
      ? await git.exportAppMasterBundle(row.id)
      : await git.exportWorkflowMasterBundle(row.id);
  const masterCommit =
    'appMasterCommit' in git
      ? await git.appMasterCommit(row.id)
      : await git.workflowMasterCommit(row.id);
  return safeJson({
    id: row.id,
    masterCommit,
    bundleBase64: bundle?.toString('base64') ?? null,
  });
}
