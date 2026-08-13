import path from 'node:path';
import { appBuildDir } from '~agent/paths';
import { liveAppDeployment } from './access';
import { readLiveBuildFile } from './build-identity';

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
 * Serve a static file from an app's built `app/` directory for the human-facing
 * `/app/<slug>` page and the id-based technical `/api/app/:id/app/*` route.
 * Guards against path traversal outside the app directory.
 */
export async function serveAppAppFile(
  id: string,
  rawRel: string,
): Promise<Response> {
  // Don't serve a retired/never-deployed app's bundle from leftover build files
  // via a stale direct URL: require a live, non-archived frontend deployment.
  const live = await liveAppDeployment(id, 'frontend');
  if (!live) {
    return new Response('Not found', { status: 404 });
  }
  let rel = decodeURIComponent(rawRel || '');
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  }

  const appDir = path.join(appBuildDir(id), 'app');
  const filePath = path.normalize(path.join(appDir, rel));
  if (filePath !== appDir && !filePath.startsWith(appDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  const result = await readLiveBuildFile(
    id,
    live.deploymentId,
    path.relative(appBuildDir(id), filePath),
  );
  if (!result.ok && result.reason === 'unavailable') {
    return new Response('App deployment is being finalized.', {
      status: 503,
      headers: { 'retry-after': '1' },
    });
  }
  if (!result.ok) {
    return new Response('Not found', { status: 404 });
  }
  const ext = path.extname(filePath);
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    },
  });
}
