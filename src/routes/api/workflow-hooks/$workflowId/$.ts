import { createFileRoute } from '@tanstack/react-router';

// Cap inbound webhook payloads: this endpoint authenticates with only the
// per-workflow secret, so without a limit any valid caller could send an
// unbounded JSON body and exhaust server memory before validation runs.
const MAX_WEBHOOK_BODY = 1_000_000;

/**
 * Read a request body as text, returning null once `max` bytes are exceeded so
 * the caller can reject oversized payloads instead of buffering them whole.
 */
async function readCappedText(
  request: Request,
  max: number,
): Promise<string | null> {
  const body = request.body;
  if (!body) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > max ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Public inbound webhook for workflows. Unlike the rest of the API this does
 * not require a platform session — it authenticates with the per-workflow
 * secret and starts a run with the request body (or query params) as input.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/workflow-hooks\/([^/]+)(\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];

  const { db } = await import('~/db');
  const workflow = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!workflow || workflow.status !== 'deployed') {
    return new Response('Not found', { status: 404 });
  }
  if (!workflow.webhookSecret || !workflow.currentDeploymentId) {
    return new Response('Webhook not enabled', { status: 404 });
  }
  const deployment = await db.query.workflowDeployments.findFirst({
    where: (d, { eq }) => eq(d.id, workflow.currentDeploymentId as string),
  });
  const manifest = deployment?.manifestNormalized as {
    triggers?: { webhook?: { enabled?: boolean } };
  } | null;
  if (!manifest?.triggers?.webhook?.enabled) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  const provided =
    request.headers.get('x-hatch-secret') ?? url.searchParams.get('secret');
  const { secretsMatch } = await import('~server/secrets');
  if (!secretsMatch(provided, workflow.webhookSecret)) {
    return new Response('Forbidden', { status: 403 });
  }

  const query = Object.fromEntries(url.searchParams.entries());
  delete query.secret;
  // Query params are always strings; coerce them toward the workflow's input
  // schema so numeric/boolean fields don't fail validation on GET/DELETE hooks.
  const { coerceWorkflowQueryInput } =
    await import('~server/workflows/validate');
  let input: unknown = coerceWorkflowQueryInput(workflow.inputSchema, query);
  if (request.method === 'POST' || request.method === 'PUT') {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY) {
      return new Response('Payload too large', { status: 413 });
    }
    const text = await readCappedText(request, MAX_WEBHOOK_BODY);
    if (text === null) {
      return new Response('Payload too large', { status: 413 });
    }
    if (text.trim()) {
      try {
        input = JSON.parse(text);
      } catch {
        return new Response('Request body must be JSON', { status: 400 });
      }
    }
  }

  const { startWorkflowRun } = await import('~server/workflows/execute');
  const { AppError } = await import('~server/errors');
  try {
    const result = await startWorkflowRun(id, { trigger: 'webhook', input });
    return new Response(
      JSON.stringify({ runId: result.runId, status: result.status }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    // Structured 4xx errors (e.g. input validation) are written for the
    // caller; anything else is internal detail this unauthenticated-ish
    // endpoint must not echo. Log it server-side instead.
    if (error instanceof AppError && error.status < 500) {
      return new Response(error.message, { status: error.status });
    }
    console.error(
      `[workflow-hooks] workflow ${id} run failed to start:`,
      error,
    );
    return new Response('Workflow error', { status: 502 });
  }
}

export const Route = createFileRoute('/api/workflow-hooks/$workflowId/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      DELETE: handle,
    },
  },
});
