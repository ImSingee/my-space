import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/apps\/([^/]+)\/rpc/);
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  const id = match[1];
  const { proxyAppRequest } = await import('~server/apps/runtime');
  try {
    return await proxyAppRequest(id, request, `/api/apps/${id}/rpc`);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'App backend error',
      { status: 502 },
    );
  }
}

export const Route = createFileRoute('/api/apps/$appId/rpc/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
