import { createFileRoute } from '@tanstack/react-router';

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
    const text = await request.text();
    if (text.trim()) {
      try {
        input = JSON.parse(text);
      } catch {
        return new Response('Request body must be JSON', { status: 400 });
      }
    }
  }

  const { startWorkflowRun } = await import('~server/workflows/execute');
  try {
    const result = await startWorkflowRun(id, { trigger: 'webhook', input });
    return new Response(
      JSON.stringify({ runId: result.runId, status: result.status }),
      { status: 202, headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Workflow error',
      { status: 502 },
    );
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
