import { getTailscaleManager } from '../tailscale-manager';
import { getPlatformEnv } from '../../env';
import { activeAppService } from './tailscale-services';
import {
  appLoginPage,
  authorizeAppAccess,
  finishAppAccess,
  hasAppAccess,
  startAppAccess,
} from './app-access';
import { markAppRuntimeRequest } from './runtime-auth';
import { serveAppAppFile } from './serve-app';
import { handleRpcRequest } from './runtime-api/rpc';
import { handleDataRequest } from './runtime-api/data';
import { handleKvRequest } from './runtime-api/kv';
import { handleWidgetRequest } from './runtime-api/widget';
import { handleWebhookRequest } from './runtime-api/hook';

const denied = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
/** Called before the platform SPA or Server Functions for every HTTP request. */
export async function handleAppIngress(
  request: Request,
): Promise<Response | undefined> {
  const manager = getTailscaleManager();
  const url = new URL(request.url);
  const appId = request.headers.get('x-hatch-ingress-app');
  const token = request.headers.get('x-hatch-ingress-token');
  const origin = request.headers.get('x-hatch-ingress-origin');
  const authority = request.headers.get('host') ?? url.host;
  // The helper targets the fixed IPv4 loopback listener so Vite can retain its
  // Host guard. Only that local authority may supply an external routing host.
  const host = /^127\.0\.0\.1(?::\d+)?$/.test(authority)
    ? (request.headers.get('x-forwarded-host') ?? authority)
    : authority;
  // An App origin must never fall through to the Platform when proof is absent.
  const knownHost = manager
    .snapshot()
    .services?.some((s) => s.origin && new URL(s.origin).host === host);
  if (!appId && !token && !origin) {
    const platformHost = new URL(getPlatformEnv().appUrl).host;
    const privateOrigin = manager.trustedOrigin();
    const privateHost = privateOrigin ? new URL(privateOrigin).host : null;
    if (
      knownHost ||
      (host.endsWith('.ts.net') &&
        host !== platformHost &&
        host !== privateHost)
    )
      return denied();
    if (url.pathname !== '/__hatch/app-access') return undefined;
    if (request.method !== 'GET')
      return new Response('Method not allowed', { status: 405 });
    const platformOrigin =
      privateOrigin && new URL(privateOrigin).host === host
        ? privateOrigin
        : getPlatformEnv().appUrl;
    return authorizeAppAccess(request, platformOrigin);
  }
  if (!appId || !origin || !manager.verifyIngress(token)) return denied();
  let external: URL;
  try {
    external = new URL(origin);
  } catch {
    return denied();
  }
  if (
    external.protocol !== 'https:' ||
    external.origin !== origin ||
    external.host !== host
  )
    return denied();
  const active = await activeAppService(appId, origin);
  if (!active)
    return new Response('This App entry is unavailable.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  const binding = { appId, origin, revision: active.binding.revision };
  external.pathname = url.pathname;
  external.search = url.search;
  const forwarded = new Request(external, request);
  const pathname = external.pathname;
  if (pathname.startsWith('/__hatch/')) {
    if (request.method !== 'GET')
      return new Response('Method not allowed', { status: 405 });
    if (pathname === '/__hatch/auth/callback')
      return finishAppAccess(forwarded, binding);
    if (pathname === '/__hatch/auth/start') {
      const platformOrigin = manager.trustedOrigin();
      return platformOrigin
        ? startAppAccess(forwarded, binding, platformOrigin)
        : denied();
    }
    return denied();
  }
  const api = pathname.match(
    /^\/api\/app\/([^/]+)\/(rpc|data|kv|hook|widget|app)(?:\/|$)/,
  );
  if (pathname.startsWith('/api/') && (!api || api[1] !== appId))
    return denied();
  if (api) {
    const authenticated = await hasAppAccess(forwarded, binding);
    markAppRuntimeRequest(forwarded, appId, authenticated);
    switch (api[2]) {
      case 'rpc':
        return handleRpcRequest({ request: forwarded });
      case 'data':
        return handleDataRequest({ request: forwarded });
      case 'kv':
        return handleKvRequest({ request: forwarded });
      case 'hook':
        return handleWebhookRequest({ request: forwarded });
      case 'widget':
        return handleWidgetRequest({ request: forwarded });
      case 'app': {
        if (!authenticated)
          return new Response('Unauthorized', { status: 401 });
        if (request.method !== 'GET' && request.method !== 'HEAD')
          return new Response('Method not allowed', { status: 405 });
        const response = await serveAppAppFile(
          appId,
          pathname.slice(`/api/app/${appId}/app/`.length),
        );
        response.headers.set('cache-control', 'no-store');
        return request.method === 'HEAD'
          ? new Response(null, {
              status: response.status,
              headers: response.headers,
            })
          : response;
      }
    }
  }
  if (
    pathname.startsWith('/api') ||
    pathname.startsWith('/_') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    pathname === '/login'
  )
    return denied();
  const legacy = pathname.match(/^\/app\/([^/]+)\/embed(?:\/(.*))?$/);
  if (
    pathname.startsWith('/app/') &&
    (!legacy || legacy[1] !== active.app.slug)
  )
    return denied();
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405 });
  if (!(await hasAppAccess(forwarded, binding))) {
    if (request.method === 'HEAD') return new Response(null, { status: 401 });
    return appLoginPage(forwarded);
  }
  if (!active.app.capabilities?.frontend) {
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>App API</title><body><h1>${escapeHtml(active.app.name)}</h1><p>This App has no frontend.</p><p>Runtime API: <code>/api/app/${escapeHtml(appId)}/</code></p></body></html>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }
  const rel = legacy ? (legacy[2] ?? '') : pathname.slice(1);
  let response = await serveAppAppFile(appId, rel);
  if (
    response.status === 404 &&
    !rel.split('/').at(-1)?.includes('.') &&
    request.headers.get('accept')?.includes('text/html')
  )
    response = await serveAppAppFile(appId, '');
  response.headers.set('cache-control', 'no-store');
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
