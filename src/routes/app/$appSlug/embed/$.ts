import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { appIdForSlug } from '~server/apps/access';
import { serveAppAppFile } from '~server/apps/serve-app';

export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/app\/([^/]+)\/embed(?:\/(.*))?$/);
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const id = await appIdForSlug(slug);
  if (!id) {
    return new Response('Not found', { status: 404 });
  }
  if (match[2] === undefined) {
    url.pathname = `${url.pathname}/`;
    return Response.redirect(url, 308);
  }
  return serveAppAppFile(id, match[2]);
}

export const Route = createFileRoute('/app/$appSlug/embed/$')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
