import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { serveSubappAppFile } from '~server/subapps/serve-app';

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
  return serveSubappAppFile(match[1], match[2]);
}

export const Route = createFileRoute('/app/$subappId/$')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
