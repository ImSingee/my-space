/** Deliver a notification envelope to a user-configured webhook URL. */
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '~server/secrets';
import {
  NOTIFICATION_DELIVERY_HEADER,
  NOTIFICATION_ID_HEADER,
  buildEnvelope,
} from '../contract';
import { classifyHttpStatus, type DeliveryAdapter } from '../delivery';
import { decryptWebhookSecret } from '../secrets';

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 4096;

async function readErrorSnippet(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES);
  return merged.toString('utf8').trim();
}

/** The URL's origin and path only, so query-string credentials never leak. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'webhook';
  }
}

export const deliverToWebhook: DeliveryAdapter = async ({
  deliveryId,
  attempt,
  notification,
  destination,
  sourceSlug,
}) => {
  if (!destination.url || !destination.secretCiphertext) {
    return { kind: 'fail', error: 'Webhook destination is incomplete.' };
  }
  const secret = decryptWebhookSecret(
    destination.id,
    destination.secretCiphertext,
  );
  const body = JSON.stringify(
    buildEnvelope({ notification, deliveryId, attempt, sourceSlug }),
  );
  const timestamp = String(Date.now());

  let response: Response;
  try {
    response = await fetch(destination.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Hatch-Notifications/1',
        [NOTIFICATION_ID_HEADER]: notification.id,
        [NOTIFICATION_DELIVERY_HEADER]: deliveryId,
        [HATCH_TIMESTAMP_HEADER]: timestamp,
        [HATCH_SIGNATURE_HEADER]: hatchSignature(secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timed out'
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      kind: 'retry',
      error: `Request to ${describeUrl(destination.url)} failed: ${reason}`,
    };
  }

  const verdict = classifyHttpStatus(response.status);
  if (verdict === 'success') {
    await response.body?.cancel().catch(() => {});
    return { kind: 'success', httpStatus: response.status };
  }
  const snippet = await readErrorSnippet(response);
  const redirect =
    response.status >= 300 && response.status < 400
      ? ' (redirects are not followed)'
      : '';
  return {
    kind: verdict,
    httpStatus: response.status,
    error: `Webhook responded ${response.status}${redirect}${
      snippet ? `: ${snippet}` : ''
    }`,
  };
};
