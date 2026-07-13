/**
 * Server-only: the internal REST API the Agent Runner's PlatformClient calls
 * (bearer-authenticated by internal-server.ts before requests reach here).
 *
 * Routes (all JSON):
 *   GET  /internal/api/apps                     → AppSummary[]
 *   GET  /internal/api/apps/:handle             → AppDetail (404 when absent)
 *   POST /internal/api/apps                     → CreateAppResult (scaffold files)
 *   GET  /internal/api/apps/:handle/source      → SourceBundleResponse
 *   POST /internal/api/apps/:handle/deploy      → AppDeployResponse
 *   POST /internal/api/apps/:handle/rollback    → { version }
 *   POST /internal/api/apps/:handle/query-db    → { text, rowCount }
 *   POST /internal/api/apps/:handle/query-kv    → QueryAppKvResponse
 *   GET  /internal/api/workflows                → WorkflowSummaryForAgent[]
 *   GET  /internal/api/workflows/:id            → WorkflowDetailForAgent (404)
 *   POST /internal/api/workflows                → CreateWorkflowResult
 *   GET  /internal/api/workflows/:id/source     → SourceBundleResponse
 *   POST /internal/api/workflows/:id/deploy     → WorkflowDeployResponse
 *   POST /internal/api/workflows/:id/rollback   → { version }
 */
import type http from 'node:http';
import {
  createAppRequestSchema,
  createWorkflowRequestSchema,
  deploySourceRequestSchema,
  queryAppDbRequestSchema,
  queryAppKvRequestSchema,
  rollbackRequestSchema,
  type SourceBundleResponse,
} from '~agent/protocol';
import { AppError } from '~server/errors';

/** Handle shape guard before a value flows into paths/repos/db names. */
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * JSON body cap. Deploy bundles ride in as base64 (~4/3 of the packfile), so
 * the cap must fit a real app repo while still bounding a runaway request.
 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new AppError('Payload too large.', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('Invalid JSON body.', 400));
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requireHandle(raw: string): string {
  const handle = decodeURIComponent(raw);
  if (!HANDLE_RE.test(handle)) {
    throw new AppError(`Invalid handle "${handle}".`, 400);
  }
  return handle;
}

async function resolveApp(handle: string): Promise<string> {
  const { resolveAppId } = await import('~server/apps/access');
  const id = await resolveAppId(handle);
  if (!id) throw new AppError(`App "${handle}" not found.`, 404);
  return id;
}

async function requireAppGeneration(id: string): Promise<string> {
  const { db } = await import('~/db');
  const row = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: { createdAt: true },
  });
  if (!row) throw new AppError(`App "${id}" not found.`, 404);
  return row.createdAt.toISOString();
}

async function requireWorkflow(
  id: string,
): Promise<{ id: string; generation: string }> {
  const { db } = await import('~/db');
  const row = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: { id: true, createdAt: true },
  });
  if (!row) throw new AppError(`Workflow "${id}" not found.`, 404);
  return { id: row.id, generation: row.createdAt.toISOString() };
}

function requireGeneration(
  kind: 'App' | 'Workflow',
  id: string,
  expected: string,
  actual: string,
): void {
  if (expected === actual) return;
  throw new AppError(
    `${kind} "${id}" was deleted or recreated while preparing the deploy. ` +
      'Checkout the current source and try again.',
    409,
  );
}

export async function handleInternalApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const segments = url.pathname.split('/').filter(Boolean);
    // Expect ['internal', 'api', resource, ...rest].
    if (segments[0] !== 'internal' || segments[1] !== 'api') {
      throw new AppError('Not found.', 404);
    }
    const [, , resource, ...rest] = segments;
    const method = req.method ?? 'GET';

    if (resource === 'apps') {
      await handleApps(req, res, method, rest);
      return;
    }
    if (resource === 'workflows') {
      await handleWorkflows(req, res, method, rest);
      return;
    }
    if (resource === 'agent-sessions') {
      await handleAgentSessions(res, method, rest);
      return;
    }
    throw new AppError('Not found.', 404);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) console.error('[agent-internal] request failed:', error);
    json(res, status, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAgentSessions(
  res: http.ServerResponse,
  method: string,
  rest: string[],
): Promise<void> {
  if (method !== 'GET' || rest.length !== 3 || rest[1] !== 'attachments') {
    throw new AppError('Not found.', 404);
  }
  const sessionId = decodeURIComponent(rest[0]);
  const attachmentId = decodeURIComponent(rest[2]);
  const { getAgentAttachment } = await import('~server/agent-attachments');
  const got = await getAgentAttachment(attachmentId, sessionId);
  if (!got) throw new AppError('Attachment not found.', 404);
  res.writeHead(200, {
    'content-type': got.attachment.mimeType,
    'content-length': String(got.attachment.size),
    'x-attachment-name': encodeURIComponent(got.attachment.name),
    'cache-control': 'private, no-store',
  });
  res.end(got.body);
}

async function handleApps(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const { listAppsForAgent } = await import('~server/apps/inspect');
      json(res, 200, await listAppsForAgent());
      return;
    }
    if (method === 'POST') {
      const body = createAppRequestSchema.parse(await readJsonBody(req));
      const { createApp } = await import('~server/apps/scaffold');
      json(res, 200, await createApp(body));
      return;
    }
    throw new AppError('Method not allowed.', 405);
  }

  const handle = requireHandle(rest[0]);
  const action = rest[1];

  if (!action) {
    if (method !== 'GET') throw new AppError('Method not allowed.', 405);
    const { resolveAppId } = await import('~server/apps/access');
    const id = await resolveAppId(handle);
    if (!id) throw new AppError(`App "${handle}" not found.`, 404);
    const { getAppDetailForAgent } = await import('~server/apps/inspect');
    const detail = await getAppDetailForAgent(id);
    if (!detail) throw new AppError(`App "${handle}" not found.`, 404);
    json(res, 200, detail);
    return;
  }

  if (action === 'source' && method === 'GET') {
    const id = await resolveApp(handle);
    const generation = await requireAppGeneration(id);
    const { appMasterCommit, exportAppMasterBundle } =
      await import('~server/apps/git');
    const commit = await appMasterCommit(id);
    const bundle = await exportAppMasterBundle(id);
    const payload: SourceBundleResponse = {
      id,
      generation,
      masterCommit: commit,
      bundleBase64: bundle ? bundle.toString('base64') : null,
    };
    json(res, 200, payload);
    return;
  }

  if (action === 'deploy' && method === 'POST') {
    const id = await resolveApp(handle);
    const body = deploySourceRequestSchema.parse(await readJsonBody(req));
    requireGeneration(
      'App',
      id,
      body.generation,
      await requireAppGeneration(id),
    );
    const { stageAppBundleCheckout } = await import('~server/apps/git');
    const staged = await stageAppBundleCheckout(
      id,
      Buffer.from(body.bundleBase64, 'base64'),
    );
    try {
      const { deployApp } = await import('~server/apps/deploy');
      const result = await deployApp(id, {
        sourceDir: staged.dir,
        message: body.message,
      });
      const { appSlug } = await import('~server/apps/access');
      json(res, 200, {
        deploymentId: result.deploymentId,
        version: result.version,
        slug: (await appSlug(id)) ?? id,
        normalized: result.normalized,
      });
    } finally {
      await staged.cleanup();
    }
    return;
  }

  if (action === 'rollback' && method === 'POST') {
    const id = await resolveApp(handle);
    const body = rollbackRequestSchema.parse(await readJsonBody(req));
    const { rollbackAppToVersion } = await import('~server/apps/manage');
    json(res, 200, await rollbackAppToVersion(id, body.version));
    return;
  }

  if (action === 'query-db' && method === 'POST') {
    const id = await resolveApp(handle);
    const body = queryAppDbRequestSchema.parse(await readJsonBody(req));
    const { queryAppDatabase } = await import('~server/apps/query-db');
    // When the runner aborts the request (run cancelled), tear down the
    // running statement instead of letting it run to its 30s timeout.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    json(res, 200, await queryAppDatabase(id, body.sql, abort.signal));
    return;
  }

  if (action === 'query-kv' && method === 'POST') {
    const id = await resolveApp(handle);
    const body = queryAppKvRequestSchema.parse(await readJsonBody(req));
    const { queryAppKv } = await import('~server/apps/query-kv');
    json(res, 200, await queryAppKv(id, body));
    return;
  }

  throw new AppError('Not found.', 404);
}

async function handleWorkflows(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const { listWorkflowsForAgent } =
        await import('~server/workflows/inspect');
      json(res, 200, await listWorkflowsForAgent());
      return;
    }
    if (method === 'POST') {
      const body = createWorkflowRequestSchema.parse(await readJsonBody(req));
      const { createWorkflow } = await import('~server/workflows/scaffold');
      json(res, 200, await createWorkflow(body));
      return;
    }
    throw new AppError('Method not allowed.', 405);
  }

  const id = requireHandle(rest[0]);
  const action = rest[1];

  if (!action) {
    if (method !== 'GET') throw new AppError('Method not allowed.', 405);
    const { getWorkflowDetailForAgent } =
      await import('~server/workflows/inspect');
    const detail = await getWorkflowDetailForAgent(id);
    if (!detail) throw new AppError(`Workflow "${id}" not found.`, 404);
    json(res, 200, detail);
    return;
  }

  if (action === 'source' && method === 'GET') {
    const { generation } = await requireWorkflow(id);
    const { workflowMasterCommit, exportWorkflowMasterBundle } =
      await import('~server/workflows/git');
    const commit = await workflowMasterCommit(id);
    const bundle = await exportWorkflowMasterBundle(id);
    const payload: SourceBundleResponse = {
      id,
      generation,
      masterCommit: commit,
      bundleBase64: bundle ? bundle.toString('base64') : null,
    };
    json(res, 200, payload);
    return;
  }

  if (action === 'deploy' && method === 'POST') {
    const body = deploySourceRequestSchema.parse(await readJsonBody(req));
    const workflow = await requireWorkflow(id);
    requireGeneration('Workflow', id, body.generation, workflow.generation);
    const { stageWorkflowBundleCheckout } =
      await import('~server/workflows/git');
    const staged = await stageWorkflowBundleCheckout(
      id,
      Buffer.from(body.bundleBase64, 'base64'),
    );
    try {
      const { deployWorkflow } = await import('~server/workflows/deploy');
      const result = await deployWorkflow(id, {
        sourceDir: staged.dir,
        message: body.message,
        expectedGeneration: body.generation,
      });
      json(res, 200, {
        deploymentId: result.deploymentId,
        version: result.version,
        normalized: result.normalized,
      });
    } finally {
      await staged.cleanup();
    }
    return;
  }

  if (action === 'rollback' && method === 'POST') {
    await requireWorkflow(id);
    const body = rollbackRequestSchema.parse(await readJsonBody(req));
    const { rollbackWorkflowToVersion } =
      await import('~server/workflows/manage');
    json(res, 200, await rollbackWorkflowToVersion(id, body.version));
    return;
  }

  throw new AppError('Not found.', 404);
}
