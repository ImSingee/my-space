/** Deliver a notification to a signed-in iOS device through APNs. */
import { db } from '~/db';
import { getPlatformEnv } from '~/env';
import type { NotificationApnsEnvironment } from '~/db/schema';
import {
  APNS_ORIGINS,
  invalidateProviderToken,
  sendApnsRequest,
  type ApnsSendRequest,
  type ApnsSendResult,
} from '../apns/client';
import { getApnsCredentials } from '../apns/credentials';
import { buildEncryptedApnsPayload } from '../apns/payload';
import type { DeliveryAdapter, DeliveryOutcome } from '../delivery';
import { decryptDeviceKey } from '../secrets';

/** Undelivered pushes are useless after a day; APNs drops them then. */
const PUSH_EXPIRY_MS = 24 * 60 * 60_000;

/** APNs rejections meaning this token will never work again. */
const DEAD_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
]);
/** APNs rejections caused by this instance's credentials or configuration. */
const CREDENTIAL_REASONS = new Set([
  'InvalidProviderToken',
  'MissingProviderToken',
  'BadCertificate',
  'BadCertificateEnvironment',
  'Forbidden',
  'TopicDisallowed',
  'BadTopic',
  'MissingTopic',
]);

export function classifyApnsResult(result: ApnsSendResult): DeliveryOutcome {
  if (result.status === 200) {
    return {
      kind: 'success',
      httpStatus: 200,
      destination: { lastError: null },
    };
  }
  const reason = result.reason ?? 'Unknown';
  const error = `APNs rejected the push (${result.status} ${reason}).`;
  if (result.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
    return {
      kind: 'fail',
      httpStatus: result.status,
      error: `${error} The device is no longer registered and was disabled.`,
      destination: { disable: true, lastError: error },
    };
  }
  if (reason === 'ExpiredProviderToken') {
    return { kind: 'retry', httpStatus: result.status, error };
  }
  if (result.status === 403 || CREDENTIAL_REASONS.has(reason)) {
    return {
      kind: 'fail',
      httpStatus: result.status,
      error: `${error} Check this instance's APNs credentials.`,
      destination: { lastError: error },
    };
  }
  if (result.status === 429 || result.status >= 500) {
    return { kind: 'retry', httpStatus: result.status, error };
  }
  return { kind: 'fail', httpStatus: result.status, error };
}

export function createDeviceAdapter(
  options: {
    send?: (request: ApnsSendRequest) => Promise<ApnsSendResult>;
    origins?: Record<NotificationApnsEnvironment, string>;
  } = {},
): DeliveryAdapter {
  const send = options.send ?? sendApnsRequest;
  const origins = options.origins ?? APNS_ORIGINS;
  return async ({ notification, destination }) => {
    if (
      !destination.apnsToken ||
      !destination.apnsEnvironment ||
      !destination.e2eKeyId ||
      !destination.e2eKeyCiphertext ||
      !destination.sessionId
    ) {
      return { kind: 'fail', error: 'Device destination is incomplete.' };
    }
    const session = await db.query.session.findFirst({
      where: { id: destination.sessionId },
      columns: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return {
        kind: 'fail',
        error: 'The device sign-in session ended; the device was removed.',
        destination: { remove: true },
      };
    }

    let credentials;
    try {
      credentials = getApnsCredentials();
    } catch (error) {
      return {
        kind: 'fail',
        error: `APNs is misconfigured: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const key = credentials.keys[destination.apnsEnvironment];
    if (!credentials.teamId || !key) {
      return {
        kind: 'fail',
        error: `No APNs ${destination.apnsEnvironment} key is configured on this instance.`,
      };
    }

    const payload = buildEncryptedApnsPayload(
      decryptDeviceKey(destination.id, destination.e2eKeyCiphertext),
      destination.e2eKeyId,
      {
        v: 1,
        id: notification.id,
        o: getPlatformEnv().appUrl,
        t: notification.title,
        b: notification.body,
        s: notification.sourceName,
        k: notification.kindName,
        g: notification.appId ?? notification.channelId ?? 'platform',
        u: notification.url,
        at: notification.occurredAt.toISOString(),
      },
    );
    let result: ApnsSendResult;
    try {
      result = await send({
        origin: origins[destination.apnsEnvironment],
        teamId: credentials.teamId,
        key,
        topic: credentials.topic,
        deviceToken: destination.apnsToken,
        payload,
        collapseId: notification.id,
        expiresAt: new Date(Date.now() + PUSH_EXPIRY_MS),
      });
    } catch (error) {
      return {
        kind: 'retry',
        error: `APNs request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (result.reason === 'ExpiredProviderToken') {
      invalidateProviderToken(credentials.teamId, key);
    }
    const outcome = classifyApnsResult(result);
    // The verdict is about the token we sent; the phone may have registered a
    // new one on this destination while the request was in flight.
    return outcome.destination
      ? {
          ...outcome,
          destination: {
            ...outcome.destination,
            ifApnsToken: destination.apnsToken,
          },
        }
      : outcome;
  };
}
