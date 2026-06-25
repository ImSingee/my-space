import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/subapps\/([^/]+)\/rpc/);
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  const id = match[1];
  const { proxySubappRequest } = await import('~server/subapps/runtime');
  try {
    return await proxySubappRequest(id, request, `/api/subapps/${id}/rpc`);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Subapp backend error',
      { status: 502 },
    );
  }
}

export const Route = createFileRoute('/api/subapps/$subappId/rpc/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
