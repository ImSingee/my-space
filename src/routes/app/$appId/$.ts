import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { resolveAppId } from '~server/apps/access';
import { serveAppAppFile } from '~server/apps/serve-app';

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/app\/([^/]+)\/(.*)$/);
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  // The first segment may be the immutable id or the mutable slug; map it back
  // to the canonical id that keys the build artifacts.
  const id = await resolveAppId(decodeURIComponent(match[1]));
  if (!id) {
    return new Response('Not found', { status: 404 });
  }
  return serveAppAppFile(id, match[2]);
}

export const Route = createFileRoute('/app/$appId/$')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
