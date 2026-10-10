import { authorizeAppRuntimeRequest } from '../runtime-auth';
import { serveAppAppFile } from '~server/apps/serve-app';
import { parseAppApiPath } from './path';

export async function handleAppRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  if (!(await authorizeAppRuntimeRequest(request, parsed?.id ?? '')))
    return new Response('Unauthorized', { status: 401 });
  const match = parsed?.rest.match(/^\/app\/(.*)$/);
  if (!parsed || !match) {
    return new Response('Not found', { status: 404 });
  }
  return serveAppAppFile(parsed.id, match[1]);
}
