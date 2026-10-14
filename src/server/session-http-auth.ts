/** Session-only authentication shared by Agent routes and the native API. */
import { auth } from '~auth/server';
import { getPlatformEnv } from '~/env';
import { getTailscaleManager } from './tailscale-manager';

function denied(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Accept only configured public origins, never an arbitrary Host header. */
export function isTrustedSessionOrigin(origin: string): boolean {
  return (
    origin === getPlatformEnv().appUrl ||
    origin === getTailscaleManager().trustedOrigin()
  );
}

export function sessionOriginError(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin !== null && !isTrustedSessionOrigin(origin)) {
    return denied('Cross-origin request denied', 403);
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return denied('Cross-origin request denied', 403);
  }
  return null;
}

/**
 * Explicit credentials never fall back to a Cookie. Public API keys and Runner
 * JWTs intentionally do not grant an interactive user session. This preserves
 * the platform's existing single-tenant boundary without expanding credential
 * authority. Native callers omit browser Origin headers; no CORS is enabled.
 */
export async function authenticateSessionRequest(
  request: Request,
  options: { bearerOnly?: boolean } = {},
) {
  const originError = sessionOriginError(request);
  if (originError) return originError;
  const headers = request.headers;
  if (headers.has('x-api-key')) return denied('Unauthorized', 401);
  let credentials: Headers;
  if (headers.has('authorization')) {
    const token = /^Bearer\s+(\S+)$/i.exec(
      headers.get('authorization') ?? '',
    )?.[1];
    if (!token || token.split('.').length === 3)
      return denied('Unauthorized', 401);
    credentials = new Headers({ authorization: `Bearer ${token}` });
  } else {
    if (options.bearerOnly) return denied('Unauthorized', 401);
    credentials = new Headers({ cookie: headers.get('cookie') ?? '' });
  }
  const session = await auth.api.getSession({ headers: credentials });
  return session ?? denied('Unauthorized', 401);
}
