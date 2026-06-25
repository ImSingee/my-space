import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createFileRoute } from '@tanstack/react-router';
import { subappBuildDir } from '~agent/paths';
import { auth } from '~auth/server';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/subapps\/([^/]+)\/app\/(.*)$/);
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  const id = match[1];
  let rel = decodeURIComponent(match[2] || '');
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  }

  const appDir = path.join(subappBuildDir(id), 'app');
  const filePath = path.normalize(path.join(appDir, rel));
  if (filePath !== appDir && !filePath.startsWith(appDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

export const Route = createFileRoute('/api/subapps/$subappId/app/$')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
