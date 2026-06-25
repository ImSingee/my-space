import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createFileRoute } from '@tanstack/react-router';
import { appBuildDir } from '~agent/paths';
import { auth } from '~auth/server';

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/apps\/([^/]+)\/widget\/([^/]+?)(?:\.js)?$/,
  );
  if (!match) {
    return new Response('Not found', { status: 404 });
  }
  const id = match[1];
  const widgetId = match[2];

  const widgetsDir = path.join(appBuildDir(id), 'widgets');
  const filePath = path.normalize(path.join(widgetsDir, `${widgetId}.js`));
  if (!filePath.startsWith(widgetsDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

export const Route = createFileRoute('/api/apps/$appId/widget/$widgetId')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
