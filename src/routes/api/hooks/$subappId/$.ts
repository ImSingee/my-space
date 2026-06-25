import { createFileRoute } from '@tanstack/react-router';

/**
 * Public inbound webhook endpoint. Unlike the authenticated subapp routes this
 * is reachable without a platform session, so callers must present the
 * per-subapp secret (header `x-hatch-secret` or `?secret=`). Verified requests
 * are proxied to the subapp backend under `/__webhook/...`.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/hooks\/([^/]+)(\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];

  const { db } = await import('~/db');
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  if (!subapp || subapp.status !== 'deployed') {
    return new Response('Not found', { status: 404 });
  }
  if (!subapp.capabilities?.webhook || !subapp.webhookSecret) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  const provided =
    request.headers.get('x-hatch-secret') ?? url.searchParams.get('secret');
  if (!provided || provided !== subapp.webhookSecret) {
    return new Response('Forbidden', { status: 403 });
  }

  const { proxySubappRequest } = await import('~server/subapps/runtime');
  try {
    return await proxySubappRequest(
      id,
      request,
      `/api/hooks/${id}`,
      '/__webhook',
    );
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Subapp backend error',
      { status: 502 },
    );
  }
}

export const Route = createFileRoute('/api/hooks/$subappId/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      DELETE: handle,
    },
  },
});
