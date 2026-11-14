/**
 * External Channel push endpoint:
 *
 *   POST /api/notifications/channel/<channelId>  → 202 { id, deduplicated }
 *
 * The caller presents the channel token in `x-hatch-secret` (preferred) or
 * `?secret=`; header presence wins, even when empty. Only the token's sha256
 * is stored, compared in constant time.
 */
import { db } from '~/db';
import type { notificationChannels } from '~/db/schema';
import { readCappedText } from '~server/http-body';
import { secretsMatch } from '~server/secrets';
import {
  MAX_NOTIFICATION_BODY_BYTES,
  findKind,
  notificationPushSchema,
} from './contract';
import { ingestNotification, type IngestResult } from './ingest';
import { hashChannelToken } from './secrets';

type NotificationChannel = typeof notificationChannels.$inferSelect;

export const CHANNEL_SECRET_HEADER = 'x-hatch-secret';

export function channelPushPath(channelId: string): string {
  return `/api/notifications/channel/${channelId}`;
}

export async function handleChannelPush(
  request: Request,
  channelId: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'POST' },
    });
  }
  const url = new URL(request.url);
  const presented = request.headers.has(CHANNEL_SECRET_HEADER)
    ? request.headers.get(CHANNEL_SECRET_HEADER)
    : url.searchParams.get('secret');

  const channel = await db.query.notificationChannels.findFirst({
    where: { id: channelId },
  });
  if (
    !channel ||
    !presented ||
    !secretsMatch(hashChannelToken(presented), channel.tokenHash)
  ) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!channel.enabled) {
    return new Response('Channel is disabled', { status: 403 });
  }

  const rawBody = await readCappedText(request, MAX_NOTIFICATION_BODY_BYTES);
  if (rawBody === null) {
    return new Response('Payload too large', { status: 413 });
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new Response('Body must be JSON', { status: 400 });
  }
  const result = await ingestChannelPush(channel, json);
  if (!result.ok) {
    return new Response(result.message, { status: result.status });
  }
  return Response.json(
    { id: result.id, deduplicated: result.deduplicated },
    { status: 202 },
  );
}

/**
 * Validate a push body against one Channel's declared kinds and ingest it.
 * Callers authenticate the sender and reject disabled channels first.
 */
export async function ingestChannelPush(
  channel: Pick<NotificationChannel, 'id' | 'name' | 'kinds'>,
  body: unknown,
): Promise<
  | ({ ok: true } & IngestResult)
  | { ok: false; status: 400 | 422; message: string }
> {
  const push = notificationPushSchema.safeParse(body);
  if (!push.success) {
    return {
      ok: false,
      status: 400,
      message: push.error.issues[0]?.message ?? 'Invalid request',
    };
  }
  const kind = findKind(channel.kinds, push.data.kind);
  if (!kind) {
    return {
      ok: false,
      status: 422,
      message: `Notification kind "${push.data.kind}" is not declared by this channel`,
    };
  }
  const result = await ingestNotification({
    source: { type: 'channel', channelId: channel.id, name: channel.name },
    kind,
    push: push.data,
  });
  return { ok: true, ...result };
}
