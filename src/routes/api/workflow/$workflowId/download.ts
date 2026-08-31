import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createFileRoute } from '@tanstack/react-router';
import { workflowDeploymentArtifactDir } from '~agent/paths';
import { auth } from '~auth/server';
import { db } from '~/db';

/**
 * Download a workflow deployment's built artifact (the bundled single-file
 * program). Auth-gated; the deployment id is resolved against the workflow so
 * it can't be a path-traversal payload.
 */
export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/workflow\/([^/]+)\/download\/?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const workflowId = match[1];
  const deploymentId = url.searchParams.get('deployment') ?? '';

  const deployment = deploymentId
    ? await db.query.workflowDeployments.findFirst({
        where: { id: deploymentId, workflowId },
      })
    : null;
  if (!deployment) return new Response('Not found', { status: 404 });

  const file = path.join(
    workflowDeploymentArtifactDir(workflowId, deployment.id),
    'workflow.js',
  );
  try {
    const body = await fs.readFile(file);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'content-disposition': `attachment; filename="${workflowId}-v${deployment.version}.js"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Artifact not found', { status: 404 });
  }
}

export const Route = createFileRoute('/api/workflow/$workflowId/download')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
