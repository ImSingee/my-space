import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { db } from '~/db';

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/apps\/([^/]+)\/download\/?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];
  const mode = url.searchParams.get('mode') === 'repo' ? 'repo' : 'source';

  // Resolve against a real app row so the id can't be a path-traversal payload.
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!app) return new Response('Not found', { status: 404 });

  try {
    const { buildAppSourceArchive, buildAppRepoArchive } =
      await import('~server/apps/download');
    const archive =
      mode === 'repo'
        ? await buildAppRepoArchive(id)
        : await buildAppSourceArchive(id);
    return new Response(new Uint8Array(archive.body), {
      headers: {
        'content-type': archive.contentType,
        'content-disposition': `attachment; filename="${archive.filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Download failed',
      { status: 400 },
    );
  }
}

export const Route = createFileRoute('/api/apps/$appId/download')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
