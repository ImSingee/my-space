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
  // Don't resurrect an archived/never-deployed app via a retained RPC URL:
  // proxyAppRequest would cold-start it. Gate on a live deployment + backend
  // capability rather than status === 'deployed' so a redeploy (status
  // 'building', previous backend still valid) keeps serving without downtime.
  const { db } = await import('~/db');
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.backend
  ) {
    return new Response('Not found', { status: 404 });
  }
  const { proxyAppRequest } = await import('~server/apps/runtime');
  try {
    // Sign the forward with the per-app key so the backend can distinguish
    // platform-vetted calls from direct localhost traffic (another app's
    // backend can reach this backend's port; it cannot forge the signature).
    // Signing buffers the (bounded) request body — Connect unary messages are
    // small, and blobs belong in the storage API. Apps deployed before signing
    // keys existed have no secret and are forwarded unsigned.
    return await proxyAppRequest(id, request, `/api/apps/${id}/rpc`, '', {
      signWithSecret: app.signingSecret ?? undefined,
    });
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
