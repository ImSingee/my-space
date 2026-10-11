import { auth } from '~auth/server';
import { parseAppApiPath } from './path';
import { db } from '~/db';
import { assertSupportedDeployment } from '~server/apps/compatibility';
import { errorResponse } from '~server/errors';
import { proxyAppRequest } from '~server/apps/runtime';

export async function handleRpcRequest({
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
  if (!parsed || (parsed.rest !== '/rpc' && !parsed.rest.startsWith('/rpc/'))) {
    return new Response('Not found', { status: 404 });
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
    return new Response('Not found', { status: 404 });
  }
  try {
    await assertSupportedDeployment(app.currentDeploymentId);
  } catch (error) {
    return errorResponse(error, 503);
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
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : 'App backend error',
      { status: 502 },
    );
  }
}
