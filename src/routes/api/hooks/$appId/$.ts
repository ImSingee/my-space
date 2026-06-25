import { createFileRoute } from '@tanstack/react-router';

/**
 * Public inbound webhook endpoint. Unlike the authenticated app routes this
 * is reachable without a platform session, so callers must present the
 * per-app secret (header `x-hatch-secret` or `?secret=`). Verified requests
 * are proxied to the app backend under `/__webhook/...`.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/hooks\/([^/]+)(\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];

  const { db } = await import('~/db');
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!app || app.status !== 'deployed') {
    return new Response('Not found', { status: 404 });
  }
  if (!app.capabilities?.webhook || !app.webhookSecret) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  const provided =
    request.headers.get('x-hatch-secret') ?? url.searchParams.get('secret');
  if (!provided || provided !== app.webhookSecret) {
    return new Response('Forbidden', { status: 403 });
  }

  const { proxyAppRequest } = await import('~server/apps/runtime');
  try {
    return await proxyAppRequest(id, request, `/api/hooks/${id}`, '/__webhook');
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'App backend error',
      { status: 502 },
    );
  }
}

export const Route = createFileRoute('/api/hooks/$appId/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      DELETE: handle,
    },
  },
});
