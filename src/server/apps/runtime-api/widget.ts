import path from 'node:path';
import { APP_COMPATIBILITY_UPDATE_MESSAGE } from '~/app-compatibility';
import { appBuildDir } from '~agent/paths';
import { auth } from '~auth/server';
import { parseAppApiPath } from './path';

export async function handleWidgetRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  const match = parsed?.rest.match(/^\/widget\/([^/]+?)(?:\.js)?$/);
  if (!parsed || !match) {
    return new Response('Not found', { status: 404 });
  }
  const id = parsed.id;
  const widgetId = match[1];

  // Only serve a widget bundle for a live, non-archived widgets app and only
  // for an id that exists in its current manifest — otherwise stale placements
  // or direct URLs could keep executing a retired app's widget code.
  const { liveAppDeployment } = await import('~server/apps/access');
  const live = await liveAppDeployment(id, 'widgets');
  if (!live) {
    return new Response('Not found', { status: 404 });
  }
  if (live.state === 'unsupported') {
    return new Response(APP_COMPATIBILITY_UPDATE_MESSAGE, { status: 503 });
  }
  if (!live.manifest.widgets.some((w) => w.id === widgetId)) {
    return new Response('Not found', { status: 404 });
  }
  const { readLiveBuildFile } = await import('~server/apps/build-identity');

  const widgetsDir = path.join(appBuildDir(id), 'widgets');
  const filePath = path.normalize(path.join(widgetsDir, `${widgetId}.js`));
  if (!filePath.startsWith(widgetsDir + path.sep)) {
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
  return new Response(new Uint8Array(result.data), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}
