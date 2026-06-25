import { promises as fs } from 'node:fs';
import path from 'node:path';
import { subappBuildDir } from '~agent/paths';

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

/**
 * Serve a static file from a subapp's built `app/` directory. Shared by the
 * pretty `/app/:id/*` route and the legacy `/api/subapps/:id/app/*` route.
 * Guards against path traversal outside the app directory.
 */
export async function serveSubappAppFile(
  id: string,
  rawRel: string,
): Promise<Response> {
  let rel = decodeURIComponent(rawRel || '');
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
