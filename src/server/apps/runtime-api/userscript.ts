import { parseAppApiPath } from './path';

/**
 * Public Tampermonkey userscript endpoint. Serves `<scriptId>.user.js` for a
 * live, non-archived, userscripts-capable app whose current deployment declares
 * the script. Auth is the app-level `?token=` (NOT a platform session) so
 * Tampermonkey's background subscription + auto-update keep working. The
 * response is generated per request: the metadata block (with tokenized
 * `@updateURL`/`@downloadURL` bound to the current origin) followed by the
 * bundled script body.
 */
export async function handleUserscriptRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  const match = parsed?.rest.match(/^\/userscripts\/(.+?)\.user\.js$/);
  if (!parsed || !match) return new Response('Not found', { status: 404 });
  const id = parsed.id;
  const scriptId = match[1];
  const token = url.searchParams.get('token');

  const { resolveUserscriptDownload } = await import('~server/apps/userscript');
  const result = await resolveUserscriptDownload(
    id,
    scriptId,
    token,
    url.origin,
  );
  if (!result.ok) {
    if (result.reason === 'unavailable') {
      return new Response('App deployment is being finalized.', {
        status: 503,
        headers: { 'retry-after': '1' },
      });
    }
    return new Response(
      result.reason === 'forbidden' ? 'Forbidden' : 'Not found',
      {
        status: result.reason === 'forbidden' ? 403 : 404,
      },
    );
  }

  return new Response(result.body, {
    headers: {
      // Tampermonkey identifies a userscript by the `==UserScript==` block, not
      // the MIME type, but text/javascript keeps direct browser opens sane.
      'content-type': 'text/javascript; charset=utf-8',
      // Always re-fetch so subscription update checks see the latest version.
      'cache-control': 'no-cache',
    },
  });
}
