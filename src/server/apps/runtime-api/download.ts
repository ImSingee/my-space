import { auth } from '~auth/server';
import { db } from '~/db';
import { parseAppApiPath } from './path';

type Archive = { filename: string; contentType: string; body: Buffer };

function archiveResponse(archive: Archive): Response {
  return new Response(new Uint8Array(archive.body), {
    headers: {
      'content-type': archive.contentType,
      'content-disposition': `attachment; filename="${archive.filename}"`,
      'cache-control': 'no-store',
    },
  });
}

export async function handleDownloadRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  if (!parsed || !/^\/download\/?$/.test(parsed.rest)) {
    return new Response('Not found', { status: 404 });
  }
  const id = parsed.id;
  const modeParam = url.searchParams.get('mode');
  const mode =
    modeParam === 'repo' || modeParam === 'artifact' ? modeParam : 'source';

  // Resolve against a real app row so the id can't be a path-traversal payload.
  const app = await db.query.apps.findFirst({
    where: { id },
  });
  if (!app) return new Response('Not found', { status: 404 });

  try {
    if (mode === 'artifact') {
      const deploymentId = url.searchParams.get('deployment') ?? '';
      // Resolve the deployment against this app so the id can't be spoofed.
      const deployment = deploymentId
        ? await db.query.deployments.findFirst({
            where: { id: deploymentId, appId: id },
          })
        : null;
      if (!deployment) return new Response('Not found', { status: 404 });
      const { buildDeploymentArtifactArchive } =
        await import('~server/apps/download');
      return archiveResponse(
        await buildDeploymentArtifactArchive(
          id,
          deployment.id,
          deployment.version,
        ),
      );
    }

    const { buildAppSourceArchive, buildAppRepoArchive } =
      await import('~server/apps/download');
    const archive =
      mode === 'repo'
        ? await buildAppRepoArchive(id)
        : await buildAppSourceArchive(id);
    return archiveResponse(archive);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Download failed',
      { status: 400 },
    );
  }
}
