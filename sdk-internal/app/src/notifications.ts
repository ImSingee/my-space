// @ts-self-types="./notifications.d.ts"
/**
 * @hatch/app/notifications — push notifications from an App backend and
 * receive routed notifications when the App is a notification destination.
 */
import { hmacHeaders, runtimeEnv, verifyHmac } from './signing.js';

export type NotificationJson =
  | string
  | number
  | boolean
  | null
  | NotificationJson[]
  | { [key: string]: NotificationJson };

/** A notification of a kind declared in `notifications.kinds`. */
export type NotificationInput = {
  kind: string;
  title: string;
  body?: string;
  /**
   * Opened from the notification: an absolute http(s) URL, or a Hatch page by
   * deep link (`hatch://app/<slug>#/route`, the instance web path after
   * `hatch://`), which phones open natively and the web opens on the instance.
   */
  url?: string;
  /**
   * Whether tapping the notification on a phone opens `url` directly instead
   * of the notification's page in the Hatch app. Defaults to `true` when `url`
   * is set; pass `false` when the link is only a reference. `true` requires
   * `url`.
   */
  autoOpenUrl?: boolean;
  /** Extra structured data delivered to webhook and App destinations. */
  data?: { [key: string]: NotificationJson };
  /** Repeated pushes with the same key are stored once. */
  dedupeKey?: string;
  /** When the event happened; defaults to the time the platform accepts it. */
  occurredAt?: string | Date;
};

export type NotifyResult = { id: string; deduplicated: boolean };

export class NotificationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
  }
}

/**
 * Push a notification to the platform. Uses the platform-injected
 * `HATCH_NOTIFICATIONS_URL` and `HATCH_SIGNING_SECRET` unless overridden.
 */
export async function notify(
  input: NotificationInput,
  options: { url?: string; signingSecret?: string; signal?: AbortSignal } = {},
): Promise<NotifyResult> {
  const url = options.url ?? runtimeEnv('HATCH_NOTIFICATIONS_URL');
  const secret = options.signingSecret ?? runtimeEnv('HATCH_SIGNING_SECRET');
  if (!url || !secret) {
    throw new NotificationError(
      'Notifications are unavailable: enable capabilities.notifications and backend.',
      0,
    );
  }
  const body = JSON.stringify({
    ...input,
    occurredAt:
      input.occurredAt instanceof Date
        ? input.occurredAt.toISOString()
        : input.occurredAt,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await hmacHeaders(secret, body)),
    },
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new NotificationError(
      (await response.text()) ||
        `Notification push failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as NotifyResult;
}

/** Envelope the platform POSTs to `/__notification` on App destinations. */
export type HatchNotificationEnvelope = {
  type: 'hatch.notification';
  version: 1;
  deliveryId: string;
  /** 1-based; the same deliveryId may arrive again after a failed attempt. */
  attempt: number;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    title: string;
    body: string | null;
    url: string | null;
    /** Phone notifications open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    data: { [key: string]: NotificationJson } | null;
    dedupeKey: string | null;
    occurredAt: string;
    createdAt: string;
    source: {
      type: 'app' | 'channel' | 'platform';
      id: string | null;
      slug: string | null;
      name: string;
    };
  };
};

export class NotificationVerificationError extends Error {
  constructor(message = 'Notification request is not signed by the platform.') {
    super(message);
    this.name = 'NotificationVerificationError';
  }
}

/**
 * Verify that a `/__notification` request was signed by the platform and
 * parse its envelope. Throws `NotificationVerificationError` otherwise; answer
 * such requests with 401 and never act on them.
 */
export async function verifyNotificationRequest(
  request: Request,
  options: { signingSecret?: string; maxSkewMs?: number } = {},
): Promise<HatchNotificationEnvelope> {
  const secret = options.signingSecret ?? runtimeEnv('HATCH_SIGNING_SECRET');
  if (!secret)
    throw new NotificationVerificationError('Missing signing secret.');
  const body = await request.text();
  const valid = await verifyHmac({
    secret,
    timestamp: request.headers.get('x-hatch-timestamp'),
    signature: request.headers.get('x-hatch-signature'),
    body,
    maxSkewMs: options.maxSkewMs ?? 5 * 60_000,
  });
  if (!valid) throw new NotificationVerificationError();
  const envelope = JSON.parse(body) as HatchNotificationEnvelope;
  if (envelope?.type !== 'hatch.notification') {
    throw new NotificationVerificationError('Unexpected notification payload.');
  }
  return envelope;
}

/**
 * Successful `/__notification` response. `result` is a free-form note the
 * platform shows in the delivery history (e.g. "forwarded to Slack #ops").
 */
export function notificationResult(result?: string): Response {
  return Response.json(result === undefined ? {} : { result });
}
