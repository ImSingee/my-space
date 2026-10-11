/**
 * Public CLI API under `/api/cli/v1`: App and Workflow lifecycle for the
 * `hatch` CLI. Callers authenticate with a Better Auth session (Cookie, or
 * `Authorization: Bearer <session token>` from device login) or with a Run
 * token, or a user-owned API key in `x-api-key`. These carry the authority of
 * a signed-in user over these routes. Data, secrets, providers, users and Runner
 * control have no route here.
 */
import { z } from 'zod';
import { auth } from '~auth/server';
import { db } from '~/db';
import { AppError } from '~server/errors';
import { CliError } from './error';
import {
  createAppRequestSchema,
  createWorkflowRequestSchema,
  deploySourceRequestSchema,
  rollbackRequestSchema,
} from '~agent/protocol';
import { verifyRunToken, type RunTokenContext } from './run-token';

const fail = (code: string, status: number) => new CliError(code, status);

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Strict JSON bodies only; a cross-site form cannot send this content type. */
async function readJson(request: Request, limit = 16384) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw fail('json_required', 415);
  const reader = request.body?.getReader();
  if (!reader) throw fail('invalid_request', 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw fail('payload_too_large', 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw fail('invalid_json', 400);
  }
}

/** A Run token is a three-part JWT; anything else is a Better Auth session. */
async function authenticate(request: Request): Promise<RunTokenContext | null> {
  if (request.headers.has('x-api-key')) {
    const key = request.headers.get('x-api-key') ?? '';
    if (!/^hatch_[A-Za-z0-9_-]{64}$/.test(key)) throw fail('unauthorized', 401);
    const result = await auth.api.verifyApiKey({
      body: { key, configId: 'default' },
    });
    if (!result.valid || !result.key) throw fail('unauthorized', 401);
    // Plugin references are not foreign keys. A deleted account must not leave
    // a usable orphan credential behind.
    const owner = await db.query.user.findFirst({
      where: { id: result.key.referenceId },
      columns: { id: true },
    });
    if (!owner) throw fail('unauthorized', 401);
    return null;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get('authorization') ?? '',
  )?.[1];
  if (bearer?.split('.').length === 3) return verifyRunToken(bearer);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw fail('unauthorized', 401);
  return null;
}

const columns = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function route(request: Request, path: string[]) {
  const run = await authenticate(request);
  const [collection, rawId, action] = path;
  if (
    !['apps', 'workflows'].includes(collection) ||
    path.length > 3 ||
    !['GET', 'POST'].includes(request.method)
  )
    throw fail('not_found', 404);
  const kind = collection === 'apps' ? 'app' : 'workflow';
  const post = request.method === 'POST';

  if (rawId === undefined) {
    if (post) {
      const raw = await readJson(request);
      if (kind === 'app') {
        const { createApp } = await import('~server/apps/scaffold');
        return createApp(
          createAppRequestSchema.strict().parse(raw),
          run ? { sessionId: run.sessionId } : {},
        );
      }
      const { createWorkflow } = await import('~server/workflows/scaffold');
      return createWorkflow(createWorkflowRequestSchema.strict().parse(raw));
    }
    // Minimal inventory; internal Agent inspection includes webhook secrets
    // and execution data and is never reused here.
    return kind === 'app'
      ? db.query.apps.findMany({ columns })
      : db.query.workflows.findMany({ columns });
  }

  if (
    action !== undefined &&
    !(post ? ['deploy', 'rollback'] : ['source']).includes(action)
  )
    throw fail('not_found', 404);
  if (post && action === undefined) throw fail('not_found', 404);
  const id = z.string().min(1).max(191).parse(decodeURIComponent(rawId));
  // An exact immutable ID always wins. Legacy kebab-case IDs share the slug
  // alphabet, so another object's slug may equal this ID.
  const find = (where: { id: string } | { slug: string }) =>
    kind === 'app'
      ? db.query.apps.findFirst({ where, columns })
      : db.query.workflows.findFirst({ where, columns });
  const row = (await find({ id })) ?? (await find({ slug: id }));
  if (!row) throw fail('resource_not_found', 404);

  if (action === 'rollback') {
    const { version } = rollbackRequestSchema
      .strict()
      .parse(await readJson(request));
    if (kind === 'app') {
      const { rollbackAppToVersion } = await import('~server/apps/manage');
      return rollbackAppToVersion(row.id, version);
    }
    const { rollbackWorkflowToVersion } =
      await import('~server/workflows/manage');
    return rollbackWorkflowToVersion(row.id, version);
  }

  if (action === 'deploy') {
    const body = deploySourceRequestSchema
      .strict()
      .parse(await readJson(request, 256 * 1024 * 1024));
    if (body.generation !== row.createdAt.toISOString())
      throw fail('resource_generation_conflict', 409);
    const bundle = Buffer.from(body.bundleBase64, 'base64');
    if (kind === 'app') {
      const { stageAppBundleCheckout } = await import('~server/apps/git');
      const staged = await stageAppBundleCheckout(row.id, bundle);
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
    const staged = await stageWorkflowBundleCheckout(row.id, bundle);
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
  }

  if (action === 'source') {
    if (kind === 'app') {
      const git = await import('~server/apps/git');
      const bundle = await git.exportAppMasterBundle(row.id);
      return {
        id: row.id,
        masterCommit: await git.appMasterCommit(row.id),
        bundleBase64: bundle?.toString('base64') ?? null,
      };
    }
    const git = await import('~server/workflows/git');
    const bundle = await git.exportWorkflowMasterBundle(row.id);
    return {
      id: row.id,
      masterCommit: await git.workflowMasterCommit(row.id),
      bundleBase64: bundle?.toString('base64') ?? null,
    };
  }

  return row;
}

export async function handleCliApiRequest(request: Request): Promise<Response> {
  try {
    const path = new URL(request.url).pathname
      .slice('/api/cli/v1/'.length)
      .split('/');
    return json(await route(request, path));
  } catch (error) {
    if (error instanceof CliError)
      return json({ error: error.code }, error.status);
    if (error instanceof z.ZodError)
      return json({ error: 'invalid_request' }, 400);
    // Service AppErrors carry a client-facing message and status; any other
    // exception text stays on the server.
    if (error instanceof AppError)
      return json(
        { error: 'request_failed', message: error.message },
        error.status,
      );
    return json({ error: 'internal_error' }, 500);
  }
}
