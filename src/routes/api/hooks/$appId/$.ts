import { createFileRoute } from '@tanstack/react-router';
import type { NormalizedManifest } from '~server/apps/manifest';

/**
 * Public inbound webhook endpoint (plain HTTP — never Connect RPC). Forwards any
 * body and every HTTP verb TanStack Start can register (GET/POST/PUT/PATCH/
 * DELETE/HEAD/OPTIONS). Reachable without a platform session. Behaviour depends
 * on the app's declared webhook auth mode (from its live deployment manifest):
 *
 * - `platform` (default): the caller must present the per-app secret
 *   (`x-hatch-secret` header or `?secret=`). The platform verifies it, strips
 *   it, and forwards to the backend's `/__webhook` with an HMAC signature so the
 *   app can trust the call was vetted by the platform — the secret never reaches
 *   the app.
 * - `none`: no platform secret and no signature. The raw request is forwarded
 *   untouched; the app's `/__webhook` handler authenticates it itself.
 */
export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/hooks\/([^/]+)(\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];

  const { db } = await import('~/db');
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
  });
  // Gate on a live deployment rather than status === 'deployed' so a redeploy
  // (status 'building', previous backend still live) keeps accepting webhooks
  // without downtime — matching the RPC/static routes — while still rejecting
  // archived/never-deployed apps reached via a retained URL.
  if (!app || app.status === 'archived' || !app.currentDeploymentId) {
    return new Response('Not found', { status: 404 });
  }
  if (!app.capabilities?.webhook) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  // Auth mode is recorded on the live deployment's normalized manifest. Older
  // deployments predate the field, so default to 'platform' (the historical
  // behaviour, which always required a verified secret).
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
    columns: { manifestNormalized: true },
  });
  const auth =
    (deployment?.manifestNormalized as NormalizedManifest | null)?.webhook
      ?.auth ?? 'platform';

  const { proxyAppRequest } = await import('~server/apps/runtime');
  const base = `/api/hooks/${id}`;
  // This endpoint is reachable without a session, so never echo internal error
  // detail (backend start failures embed the process log tail — stack traces,
  // absolute paths, whatever the app printed). Log it server-side instead;
  // the owner sees the full story on the authenticated manage surfaces.
  const fail = (error: unknown) => {
    console.error(`[hooks] app ${id} webhook forward failed:`, error);
    return new Response('App backend error', { status: 502 });
  };

  if (auth === 'none') {
    // Unauthenticated passthrough. The app self-secures; proxyAppRequest still
    // strips platform headers (x-hatch-*) so a caller can't forge a signature,
    // and leaves `?secret=` intact (here it would be the app's own parameter).
    try {
      return await proxyAppRequest(id, request, base, '/__webhook', {
        preserveAuthorization: true,
      });
    } catch (error) {
      return fail(error);
    }
  }

  // platform mode: verify the shared secret before forwarding.
  if (!app.webhookSecret) {
    return new Response('Webhook not enabled', { status: 404 });
  }
  const headerSecret = request.headers.get('x-hatch-secret');
  const provided = headerSecret ?? url.searchParams.get('secret');
  const { secretsMatch } = await import('~server/secrets');
  if (!secretsMatch(provided, app.webhookSecret)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    return await proxyAppRequest(id, request, base, '/__webhook', {
      // Only strip `?secret=` when it was the credential we just verified. If
      // the caller authenticated via `x-hatch-secret`, then `?secret=` is an
      // app/provider token the backend may need, so leave it intact.
      stripSecretParam: !headerSecret,
      // The webhook secret already authenticated this request; any
      // `Authorization` header is the external caller's own credential for the
      // app's webhook handler, not the platform session, so forward it.
      preserveAuthorization: true,
      // Sign the forwarded request so the backend can verify the platform
      // vetted it (the secret itself is never forwarded). Absent only for apps
      // deployed before signing keys existed — they redeploy to gain one.
      signWithSecret: app.signingSecret ?? undefined,
    });
  } catch (error) {
    return fail(error);
  }
}

export const Route = createFileRoute('/api/hooks/$appId/$')({
  server: {
    // Register every HTTP verb TanStack Start supports so the passthrough is as
    // verb-agnostic as the platform allows — webhook providers send preflights
    // (OPTIONS), liveness probes (HEAD), and non-CRUD methods (PATCH), not just
    // GET/POST/PUT/DELETE.
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      HEAD: handle,
      OPTIONS: handle,
    },
  },
});
