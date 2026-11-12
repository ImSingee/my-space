/**
 * Deliver a notification to an App destination: a signed POST to the App
 * backend's `/__notification`. The App may answer with a free-form result
 * string that the platform stores verbatim for the delivery history.
 */
import { appCompatibility } from '~/app-compatibility';
import { db } from '~/db';
import type { NormalizedManifest } from '~server/apps/manifest';
import { callAppBackend } from '~server/apps/runtime';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '~server/secrets';
import {
  MAX_DELIVERY_RESULT,
  NOTIFICATION_DELIVERY_HEADER,
  NOTIFICATION_ID_HEADER,
  buildEnvelope,
} from '../contract';
import { classifyHttpStatus, type DeliveryAdapter } from '../delivery';

/** Backend path that receives routed notifications. */
export const APP_NOTIFICATION_PATH = '/__notification';
const APP_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * Extract the App's result: JSON `{ "result": string }` or a text/plain body.
 * Anything else is ignored so arbitrary response bodies never become results.
 */
export function parseAppResult(
  contentType: string | null,
  body: string,
): string | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { result?: unknown }).result === 'string'
      ) {
        return (parsed as { result: string }).result.slice(
          0,
          MAX_DELIVERY_RESULT,
        );
      }
    } catch {
      return null;
    }
    return null;
  }
  if (type === 'text/plain') {
    const text = body.trim();
    return text ? text.slice(0, MAX_DELIVERY_RESULT) : null;
  }
  return null;
}

export const deliverToApp: DeliveryAdapter = async ({
  deliveryId,
  attempt,
  notification,
  destination,
  sourceSlug,
}) => {
  if (!destination.appId) {
    return { kind: 'fail', error: 'App destination is incomplete.' };
  }
  const app = await db.query.apps.findFirst({
    where: { id: destination.appId },
    columns: {
      status: true,
      currentDeploymentId: true,
      signingSecret: true,
    },
  });
  if (!app || app.status === 'archived' || !app.currentDeploymentId) {
    return { kind: 'fail', error: 'App is not deployed.' };
  }
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: { manifestNormalized: true, compatibilityVersion: true },
  });
  const manifest = deployment?.manifestNormalized as
    | NormalizedManifest
    | null
    | undefined;
  if (!manifest?.notifications?.destination || !manifest.backend) {
    return { kind: 'fail', error: 'App no longer accepts notifications.' };
  }
  if (!appCompatibility(deployment?.compatibilityVersion ?? null).isSupported) {
    return {
      kind: 'fail',
      error: 'App deployment uses an unsupported compatibility version.',
    };
  }
  if (!app.signingSecret) {
    return { kind: 'fail', error: 'App has no signing secret.' };
  }

  const body = JSON.stringify(
    buildEnvelope({ notification, deliveryId, attempt, sourceSlug }),
  );
  const timestamp = String(Date.now());
  let response: { status: number; body: string; contentType: string | null };
  try {
    response = await callAppBackend(
      destination.appId,
      APP_NOTIFICATION_PATH,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [NOTIFICATION_ID_HEADER]: notification.id,
          [NOTIFICATION_DELIVERY_HEADER]: deliveryId,
          [HATCH_TIMESTAMP_HEADER]: timestamp,
          [HATCH_SIGNATURE_HEADER]: hatchSignature(
            app.signingSecret,
            timestamp,
            body,
          ),
        },
        body,
        signal: AbortSignal.timeout(APP_DELIVERY_TIMEOUT_MS),
      },
      app.currentDeploymentId,
    );
  } catch (error) {
    return {
      kind: 'retry',
      error: `App backend call failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const verdict = classifyHttpStatus(response.status);
  if (verdict === 'success') {
    return {
      kind: 'success',
      httpStatus: response.status,
      result: parseAppResult(response.contentType, response.body),
    };
  }
  const snippet = response.body.trim().slice(0, 500);
  return {
    kind: verdict,
    httpStatus: response.status,
    error: `App responded ${response.status}${snippet ? `: ${snippet}` : ''}`,
  };
};
