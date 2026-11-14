/**
 * Wire contracts shared by notification ingress (App push, Channel push) and
 * outbound delivery (webhook and App destinations).
 */
import { z } from 'zod';
import {
  NOTIFICATION_KIND_RE,
  notificationKindSchema,
} from '../../../packages/hatch-manifest/src/app-schema.js';
import type {
  JsonObject,
  NotificationKindDeclaration,
  NotificationSourceType,
} from '~/db/schema';

export { NOTIFICATION_KIND_RE, notificationKindSchema };

/** Largest accepted push request body. */
export const MAX_NOTIFICATION_BODY_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_TITLE = 200;
export const MAX_NOTIFICATION_TEXT = 4000;
export const MAX_NOTIFICATION_URL = 2048;
export const MAX_NOTIFICATION_DATA_BYTES = 32 * 1024;
export const MAX_NOTIFICATION_DEDUPE_KEY = 200;
/** App destination results are stored verbatim up to this many characters. */
export const MAX_DELIVERY_RESULT = 2000;
export const MAX_CHANNEL_KINDS = 100;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/** Body accepted from App backends and external Channel callers. */
export const notificationPushSchema = z
  .object({
    kind: z.string().regex(NOTIFICATION_KIND_RE, 'invalid notification kind'),
    title: z.string().trim().min(1).max(MAX_NOTIFICATION_TITLE),
    body: optionalText(MAX_NOTIFICATION_TEXT),
    url: z
      .string()
      .max(MAX_NOTIFICATION_URL)
      .nullish()
      .transform((value) => (value ? value : null))
      .refine((value) => value === null || isHttpUrl(value), {
        message: 'url must be an absolute http(s) URL',
      }),
    /**
     * Tapping the phone push opens `url` instead of the notification. Defaults
     * to whether there is a `url`; `false` keeps the notification page.
     */
    autoOpenUrl: z.boolean().nullish(),
    data: z
      .record(z.string(), z.json())
      .nullish()
      .transform((value) =>
        value && Object.keys(value).length > 0 ? (value as JsonObject) : null,
      )
      .refine(
        (value) =>
          value === null ||
          Buffer.byteLength(JSON.stringify(value)) <=
            MAX_NOTIFICATION_DATA_BYTES,
        {
          message: `data must serialize to at most ${MAX_NOTIFICATION_DATA_BYTES} bytes`,
        },
      ),
    dedupeKey: optionalText(MAX_NOTIFICATION_DEDUPE_KEY),
    occurredAt: z
      .string()
      .nullish()
      .transform((value) => (value ? value : null))
      .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
        message: 'occurredAt must be an ISO-8601 timestamp',
      }),
  })
  .strict()
  .superRefine((push, ctx) => {
    if (push.autoOpenUrl === true && !push.url) {
      ctx.addIssue({
        code: 'custom',
        message: 'autoOpenUrl requires url',
        path: ['autoOpenUrl'],
      });
    }
  })
  .transform((push) => ({
    ...push,
    autoOpenUrl: push.autoOpenUrl ?? push.url !== null,
  }));

export type NotificationPush = z.output<typeof notificationPushSchema>;

/** Channel kind declarations: same shape and rules as App manifest kinds. */
export const channelKindsSchema = z
  .array(notificationKindSchema)
  .min(1)
  .max(MAX_CHANNEL_KINDS)
  .superRefine((kinds, ctx) => {
    const seen = new Set<string>();
    kinds.forEach((entry, index) => {
      if (seen.has(entry.kind)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate notification kind "${entry.kind}"`,
          path: [index, 'kind'],
        });
      }
      seen.add(entry.kind);
    });
  });

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function findKind(
  kinds: readonly NotificationKindDeclaration[] | undefined,
  kind: string,
): NotificationKindDeclaration | undefined {
  return kinds?.find((entry) => entry.kind === kind);
}

/** Stored notification projected for delivery envelopes and read APIs. */
export type NotificationRecord = {
  id: string;
  sourceType: NotificationSourceType;
  appId: string | null;
  channelId: string | null;
  sourceName: string;
  kind: string;
  kindName: string;
  title: string;
  body: string | null;
  url: string | null;
  autoOpenUrl: boolean;
  data: JsonObject | null;
  dedupeKey: string | null;
  occurredAt: Date;
  createdAt: Date;
};

/** JSON body POSTed to webhook and App destinations. */
export type NotificationEnvelope = {
  type: 'hatch.notification';
  version: 1;
  deliveryId: string;
  attempt: number;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    title: string;
    body: string | null;
    url: string | null;
    /** Phone pushes open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    data: JsonObject | null;
    dedupeKey: string | null;
    occurredAt: string;
    createdAt: string;
    source: {
      type: NotificationSourceType;
      id: string | null;
      slug: string | null;
      name: string;
    };
  };
};

export function buildEnvelope(args: {
  notification: NotificationRecord;
  deliveryId: string;
  attempt: number;
  sourceSlug: string | null;
}): NotificationEnvelope {
  const { notification } = args;
  return {
    type: 'hatch.notification',
    version: 1,
    deliveryId: args.deliveryId,
    attempt: args.attempt,
    notification: {
      id: notification.id,
      kind: notification.kind,
      kindName: notification.kindName,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      autoOpenUrl: notification.autoOpenUrl,
      data: notification.data,
      dedupeKey: notification.dedupeKey,
      occurredAt: notification.occurredAt.toISOString(),
      createdAt: notification.createdAt.toISOString(),
      source: {
        type: notification.sourceType,
        id: notification.appId ?? notification.channelId,
        slug: args.sourceSlug,
        name: notification.sourceName,
      },
    },
  };
}

/** Request headers carried by every outbound notification delivery. */
export const NOTIFICATION_ID_HEADER = 'x-hatch-notification-id';
export const NOTIFICATION_DELIVERY_HEADER = 'x-hatch-delivery-id';
