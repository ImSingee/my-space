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
import { readCappedText } from '~server/http-body';
import { secretsMatch } from '~server/secrets';
import {
  MAX_NOTIFICATION_BODY_BYTES,
  findKind,
  notificationPushSchema,
} from './contract';
import { ingestNotification } from './ingest';
import { hashChannelToken } from './secrets';

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
  const push = notificationPushSchema.safeParse(json);
  if (!push.success) {
    return new Response(push.error.issues[0]?.message ?? 'Invalid request', {
      status: 400,
    });
  }
  const kind = findKind(channel.kinds, push.data.kind);
  if (!kind) {
    return new Response(
      `Notification kind "${push.data.kind}" is not declared by this channel`,
      { status: 422 },
    );
  }
  const result = await ingestNotification({
    source: { type: 'channel', channelId: channel.id, name: channel.name },
    kind,
    push: push.data,
  });
  return Response.json(result, { status: 202 });
}
