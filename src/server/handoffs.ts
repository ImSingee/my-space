import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, gt, inArray, like, lt, or } from 'drizzle-orm';
import { getCookies } from 'better-auth/cookies';
import { z } from 'zod';
import { auth } from '~auth/server';
import { db, schema } from '~/db';
import { getPlatformEnv } from '~/env';
import { AppError } from '~server/errors';
import {
  isTrustedSessionOrigin,
  sessionOriginError,
} from '~server/session-http-auth';
import { readBoundedText } from './platform-api/body';
import {
  handoffTargetSchema,
  resolveHandoffTarget,
  type HandoffTarget,
} from './handoff-targets';

const TICKET_LIFETIME_MS = 60_000;
const PREFIX = 'handoff:';
const LEGACY_PREFIX = 'app-handoff:';
const commonPayload = {
  sessionId: z.string().min(1),
  origin: z.string(),
  targetPath: z.string(),
};
const payloadSchema = z.strictObject({
  ...commonPayload,
  target: handoffTargetSchema,
});
// Tickets issued immediately before an upgrade still live for up to 60 seconds.
const legacyPayloadSchema = z
  .strictObject({ ...commonPayload, appId: z.string().min(1).max(191) })
  .transform(({ appId, ...payload }) => ({
    ...payload,
    target: { type: 'app' as const, id: appId },
  }));
const ticketId = (ticket: string, prefix = PREFIX) =>
  prefix + createHash('sha256').update(ticket).digest('hex');

function requestOrigin(request: Request) {
  const origin = new URL(request.url).origin;
  if (
    !isTrustedSessionOrigin(origin) ||
    sessionOriginError(request) ||
    (request.headers.has('origin') && request.headers.get('origin') !== origin)
  )
    throw new AppError('Wrong instance origin', 403);
  return origin;
}

export async function createHandoff(
  request: Request,
  session: { id: string; expiresAt: Date },
  target: HandoffTarget,
) {
  const origin = requestOrigin(request);
  const parsedTarget = handoffTargetSchema.safeParse(target);
  if (!parsedTarget.success) throw new AppError('Invalid handoff target', 400);
  const targetPath = await resolveHandoffTarget(parsedTarget.data);
  if (!targetPath) throw new AppError('Handoff target not found', 404);
  const now = new Date();
  const expiresAt = new Date(
    Math.min(now.getTime() + TICKET_LIFETIME_MS, session.expiresAt.getTime()),
  );
  if (expiresAt <= now) throw new AppError('Unauthorized', 401);
  const ticket = randomBytes(32).toString('base64url');
  // Prune only our own expired records; no auth verification records are touched.
  await db
    .delete(schema.verification)
    .where(
      and(
        or(
          like(schema.verification.id, `${PREFIX}%`),
          like(schema.verification.id, `${LEGACY_PREFIX}%`),
        ),
        lt(schema.verification.expiresAt, now),
      ),
    );
  await db.insert(schema.verification).values({
    id: ticketId(ticket),
    identifier: PREFIX + session.id,
    value: JSON.stringify({
      sessionId: session.id,
      target: parsedTarget.data,
      origin,
      targetPath,
    }),
    expiresAt,
  });
  return {
    url: `${origin}/api/auth/handoffs/consume`,
    ticket,
    expiresAt: expiresAt.toISOString(),
    targetPath,
  };
}

/**
 * Consume once into a real HttpOnly WebView cookie. The cookie uses the very
 * same server-side session as native, so sign-out/revocation ends both. The
 * ticket is only sent in the POST body, never a URL, redirect, or JS bridge.
 */
async function consumeHandoff(request: Request) {
  const origin = requestOrigin(request);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  ) {
    throw new AppError('Expected application/x-www-form-urlencoded', 415);
  }
  const params = new URLSearchParams(await readBoundedText(request, 1024));
  if (
    params.size !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(params.get('ticket') ?? '')
  ) {
    throw new AppError('Invalid handoff', 400);
  }
  // PostgreSQL DELETE RETURNING is atomic across concurrent consumers/servers.
  const [record] = await db
    .delete(schema.verification)
    .where(
      and(
        inArray(schema.verification.id, [
          ticketId(params.get('ticket')!),
          ticketId(params.get('ticket')!, LEGACY_PREFIX),
        ]),
        gt(schema.verification.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!record) throw new AppError('Handoff expired or already used', 401);
  let storedPayload: unknown;
  try {
    storedPayload = JSON.parse(record.value);
  } catch {
    throw new AppError('Invalid handoff', 403);
  }
  const legacy = record.id.startsWith(LEGACY_PREFIX);
  const parsed = (legacy ? legacyPayloadSchema : payloadSchema).safeParse(
    storedPayload,
  );
  if (
    !parsed.success ||
    parsed.data.origin !== origin ||
    record.identifier !==
      (legacy ? LEGACY_PREFIX : PREFIX) + parsed.data.sessionId
  )
    throw new AppError('Invalid handoff', 403);
  const payload = parsed.data;
  const session = await db.query.session.findFirst({
    where: { id: payload.sessionId, expiresAt: { gt: new Date() } },
  });
  if (!session) throw new AppError('Session has ended', 401);
  const targetPath = await resolveHandoffTarget(payload.target);
  if (!targetPath || targetPath !== payload.targetPath) {
    throw new AppError('Handoff target is no longer available', 409);
  }
  const cookie = getCookies(auth.options).sessionToken;
  // Better Auth/Better Call's signed-cookie wire format: percent-encoded
  // token + '.' + HMAC-SHA256(base64). A real-auth integration test protects
  // this interoperability boundary on dependency updates.
  const signature = createHmac('sha256', getPlatformEnv().betterAuthSecret)
    .update(session.token)
    .digest('base64');
  const value = encodeURIComponent(`${session.token}.${signature}`);
  const maxAge = Math.max(
    0,
    Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
  );
  const secure = cookie.attributes.secure || origin.startsWith('https:');
  return new Response(null, {
    status: 303,
    headers: {
      location: targetPath,
      'set-cookie': `${cookie.name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

/** Native auth transport: a form POST and redirect cannot be a unary RPC. */
export async function handleHandoffRequest(
  request: Request,
): Promise<Response> {
  let response: Response;
  try {
    if (request.method !== 'POST') {
      response = new Response('Method not allowed', {
        status: 405,
        headers: { allow: 'POST' },
      });
    } else {
      response = await consumeHandoff(request);
    }
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    response = Response.json(
      {
        message:
          status < 500 && error instanceof AppError
            ? error.message
            : 'Internal server error.',
      },
      { status },
    );
  }
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}
