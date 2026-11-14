import { db } from '~/db';
import { assertSupportedDeployment } from '~server/apps/compatibility';
import type { NormalizedManifest } from '~server/apps/manifest';
import { errorResponse } from '~server/errors';
import { readCappedText } from '~server/http-body';
import {
  MAX_NOTIFICATION_BODY_BYTES,
  findKind,
  notificationPushSchema,
} from '~server/notifications/contract';
import { ingestNotification } from '~server/notifications/ingest';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  verifyHatchSignature,
} from '~server/secrets';
import { parseAppApiPath } from './path';

/**
 * App-facing notification push endpoint:
 *
 *   POST /api/app/<id>/notifications  → 202 { id, deduplicated }
 *
 * Called by the App's own backend and authenticated like KV: an HMAC over
 * `<timestamp>.<rawBody>` with the per-app signing secret. The App id in the
 * path plus that secret means an App can only push as itself, and only kinds
 * its live deployment declares.
 */
export async function handleNotificationRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const parsed = parseAppApiPath(new URL(request.url).pathname);
  if (!parsed || parsed.rest !== '/notifications') {
    return new Response('Not found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'POST' },
    });
  }

  const app = await db.query.apps.findFirst({
    where: { id: parsed.id },
    columns: {
      id: true,
      name: true,
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      signingSecret: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.notifications ||
    !app.signingSecret
  ) {
    return new Response('Not found', { status: 404 });
  }

  const rawBody = await readCappedText(request, MAX_NOTIFICATION_BODY_BYTES);
  if (rawBody === null) {
    return new Response('Payload too large', { status: 413 });
  }
  const verified = verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  });
  if (!verified) return new Response('Forbidden', { status: 403 });

  try {
    await assertSupportedDeployment(app.currentDeploymentId);
  } catch (error) {
    return errorResponse(error, 503);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new Response('Body must be JSON', { status: 400 });
  }
  const push = notificationPushSchema.safeParse(json);
  if (!push.success) {
    return new Response(push.error.issues[0]?.message ?? 'Invalid request', {
      status: 400,
    });
  }

  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  const kind = findKind(manifest?.notifications?.kinds, push.data.kind);
  if (!kind) {
    return new Response(
      `Notification kind "${push.data.kind}" is not declared in the live manifest`,
      { status: 422 },
    );
  }

  const result = await ingestNotification({
    source: { type: 'app', appId: app.id, name: app.name },
    kind,
    push: push.data,
  });
  return Response.json(
    { id: result.id, deduplicated: result.deduplicated },
    { status: 202 },
  );
}
