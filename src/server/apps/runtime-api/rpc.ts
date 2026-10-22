import {
  authenticateCredential,
  CredentialError,
} from '~server/auth/credentials';
import { RunTokenError } from '~server/agent-runner/run-auth';
import { getPlatformEnv } from '~/env';
import { getTailscaleManager } from '~server/tailscale-manager';
import { parseAppApiPath } from './path';
import { db } from '~/db';
import { assertSupportedDeployment } from '~server/apps/compatibility';
import { proxyAppRequest } from '~server/apps/runtime';

/** Route-owned failures use Connect JSON, without management error envelopes. */
function rpcError(status: number, code: string, message: string) {
  return Response.json(
    { code, message },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export async function handleRpcRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const headers = request.headers;
  const origin = headers.get('origin');
  if (
    (origin &&
      origin !== getPlatformEnv().appUrl &&
      origin !== getTailscaleManager().trustedOrigin()) ||
    (!headers.has('authorization') &&
      !headers.has('x-api-key') &&
      headers.get('sec-fetch-site') === 'cross-site')
  ) {
    return rpcError(403, 'permission_denied', 'Cross-origin request denied.');
  }
  try {
    await authenticateCredential(request);
  } catch (error) {
    if (error instanceof CredentialError || error instanceof RunTokenError)
      return rpcError(401, 'unauthenticated', 'Authentication required.');
    return rpcError(503, 'unavailable', 'Authentication unavailable.');
  }
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  if (!parsed || (parsed.rest !== '/rpc' && !parsed.rest.startsWith('/rpc/'))) {
    return rpcError(404, 'not_found', 'App backend not found.');
  }
  const id = parsed.id;
  // Don't resurrect an archived/never-deployed app via a retained RPC URL:
  // proxyAppRequest would cold-start it. Gate on a live deployment + backend
  // capability rather than status === 'deployed' so a redeploy (status
  // 'building', previous backend still valid) keeps serving without downtime.
  const app = await db.query.apps.findFirst({
    where: { id },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.backend
  ) {
    return rpcError(404, 'not_found', 'App backend not found.');
  }
  try {
    await assertSupportedDeployment(app.currentDeploymentId);
  } catch {
    return rpcError(
      503,
      'unavailable',
      'App deployment cannot run on this platform.',
    );
  }
  try {
    // Sign the forward with the per-app key so the backend can distinguish
    // platform-vetted calls from direct localhost traffic (another app's
    // backend can reach this backend's port; it cannot forge the signature).
    // Signing buffers the bounded request body. Apps deployed before signing
    // keys existed have no secret and are forwarded unsigned.
    return await proxyAppRequest(id, request, `${parsed.prefix}/rpc`, '', {
      signWithSecret: app.signingSecret ?? undefined,
      expectedDeploymentId: app.currentDeploymentId,
      platformAuthenticated: true,
    });
  } catch {
    return rpcError(502, 'unavailable', 'App backend unavailable.');
  }
}
