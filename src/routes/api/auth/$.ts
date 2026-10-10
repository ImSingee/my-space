import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { isSealedAuthPath } from '~auth/cli-policy';

export async function handleAuthRequest(request: Request): Promise<Response> {
  if (isSealedAuthPath(new URL(request.url).pathname)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return auth.handler(request);
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return await handleAuthRequest(request);
      },
      POST: async ({ request }: { request: Request }) => {
        return await handleAuthRequest(request);
      },
    },
  },
});
