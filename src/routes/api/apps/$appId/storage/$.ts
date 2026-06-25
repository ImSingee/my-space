import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';

function parse(request: Request): { id: string; key: string } | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/apps\/([^/]+)\/storage\/?(.*)$/);
  if (!match) return null;
  return { id: match[1], key: decodeURIComponent(match[2] || '') };
}

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });

  const parsed = parse(request);
  if (!parsed) return new Response('Not found', { status: 404 });
  const { id, key } = parsed;

  const storage = await import('~server/apps/storage');
  try {
    if (request.method === 'GET') {
      if (!key) {
        const url = new URL(request.url);
        const objects = await storage.listObjects(
          id,
          url.searchParams.get('prefix') ?? '',
        );
        return Response.json({ objects });
      }
      const got = await storage.getObject(id, key);
      if (!got) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(got.body), {
        headers: {
          'content-type': got.object.contentType,
          'cache-control': 'no-cache',
        },
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      if (!key) return new Response('Storage key required', { status: 400 });
      const body = new Uint8Array(await request.arrayBuffer());
      const contentType =
        request.headers.get('content-type') ?? 'application/octet-stream';
      const object = await storage.putObject(id, key, body, contentType);
      return Response.json({ object });
    }

    if (request.method === 'DELETE') {
      if (!key) return new Response('Storage key required', { status: 400 });
      const ok = await storage.deleteObject(id, key);
      return Response.json({ ok });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'Storage error',
      { status: 400 },
    );
  }
}

export const Route = createFileRoute('/api/apps/$appId/storage/$')({
  server: {
    handlers: {
      GET: handle,
      PUT: handle,
      POST: handle,
      DELETE: handle,
    },
  },
});
