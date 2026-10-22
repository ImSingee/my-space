import { createFileRoute } from '@tanstack/react-router';
import {
  appCompatibility,
  appCompatibilityRuntimeMessage,
} from '~/app-compatibility';
import type { NormalizedManifest } from '~server/apps/manifest';
import { db } from '~/db';
import { proxyAppRequest } from '~server/apps/runtime';
import { secretsMatch } from '~server/secrets';
import { authenticateCredential } from '~server/auth/credentials';
import {
  isTrustedSessionOrigin,
  sessionOriginError,
} from '~server/session-http-auth';

/**
 * Plain HTTP webhook ingress. Platform mode accepts native platform credentials
 * or the legacy per-App secret and signs raw bytes. None mode is public and
 * unsigned. Both modes strip platform credentials before authored code runs.
 */
export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/app\/([^/]+)\/hook(?:\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const id = match[1];

  const app = await db.query.apps.findFirst({
    where: { id },
  });
  // Gate on a live deployment rather than status === 'deployed' so a redeploy
  // (status 'building', previous backend still live) keeps accepting webhooks
  // without downtime — matching the RPC/static routes — while still rejecting
  // archived/never-deployed apps reached via a retained URL.
  if (!app || app.status === 'archived' || !app.currentDeploymentId) {
    return new Response('Not found', { status: 404 });
  }
  if (!app.capabilities?.webhook || !app.capabilities.backend) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  // Auth mode is recorded on the live deployment's normalized manifest. Older
  // deployments predate the field, so default to 'platform' (the historical
  // behaviour, which always required a verified secret).
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId, appId: id, status: 'deployed' },
    columns: { manifestNormalized: true, compatibilityVersion: true },
  });
  const compatibility = deployment
    ? appCompatibility(deployment.compatibilityVersion)
    : null;
  const auth =
    (deployment?.manifestNormalized as NormalizedManifest | null)?.webhook
      ?.auth ?? 'platform';

  const base = `/api/app/${id}/hook`;
  // This endpoint is reachable without a session, so never echo internal error
  // detail (backend start failures embed the process log tail — stack traces,
  // absolute paths, whatever the app printed). Keep this diagnostic fixed;
  // the owner sees backend details on authenticated management surfaces.
  const fail = () => {
    console.error(`[app-hook] app ${id} webhook forward failed`);
    return new Response('App backend error', { status: 502 });
  };

  if (auth === 'none') {
    if (!compatibility?.isSupported) {
      return new Response(appCompatibilityRuntimeMessage(compatibility), {
        status: 503,
      });
    }
    // Public at the platform layer, even with invalid incoming credentials.
    // The App verifies its own dedicated header or raw-body provider signature.
    // Reserved headers are always stripped; ?secret= remains App-owned here.
    try {
      return await proxyAppRequest(id, request, base, '/__webhook', {
        expectedDeploymentId: app.currentDeploymentId,
      });
    } catch {
      return fail();
    }
  }

  // Explicit native credentials take precedence and must never fall back to
  // Cookie or a shared secret. Secret header presence wins over the query even
  // when empty. Only remove ?secret= when it actually authenticated the call.
  let stripSecretParam = false;
  const headers = request.headers;
  if (headers.has('x-api-key') || headers.has('authorization')) {
    try {
      await authenticateCredential(request);
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
  } else if (headers.has('x-hatch-secret') || url.searchParams.has('secret')) {
    const provided =
      headers.get('x-hatch-secret') ?? url.searchParams.get('secret');
    if (!app.webhookSecret || !secretsMatch(provided, app.webhookSecret))
      return new Response('Forbidden', { status: 403 });
    stripSecretParam = !headers.has('x-hatch-secret');
  } else {
    // Cookie authentication is ambient authority, including for GET webhooks
    // that may mutate. Require positive same-origin browser evidence, not just
    // absence of a hostile Origin. Native clients use explicit credentials.
    const originError = sessionOriginError(request);
    if (originError) return originError;
    const origin = headers.get('origin');
    if (
      !(origin !== null && isTrustedSessionOrigin(origin)) &&
      !(
        headers.get('sec-fetch-site') === 'same-origin' &&
        isTrustedSessionOrigin(url.origin)
      )
    )
      return new Response('Forbidden', { status: 403 });
    try {
      await authenticateCredential(request);
    } catch {
      return new Response('Unauthorized', { status: 401 });
    }
  }
  if (!compatibility?.isSupported) {
    return new Response(appCompatibilityRuntimeMessage(compatibility), {
      status: 503,
    });
  }

  try {
    return await proxyAppRequest(id, request, base, '/__webhook', {
      stripSecretParam,
      expectedDeploymentId: app.currentDeploymentId,
      // Sign the forwarded request so the backend can verify the platform
      // vetted it (the secret itself is never forwarded). Absent only for apps
      // deployed before signing keys existed — they redeploy to gain one.
      signWithSecret: app.signingSecret ?? undefined,
    });
  } catch {
    return fail();
  }
}

export const Route = createFileRoute('/api/app/$appId/hook/$')({
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
