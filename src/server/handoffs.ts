import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, like, lt } from 'drizzle-orm';
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

const TICKET_LIFETIME_MS = 60_000;
const PREFIX = 'handoff:';
const COMPLETION_PATH = '/api/auth/handoffs/complete';
const payloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  origin: z.string(),
});
type HandoffSession = { id: string; expiresAt: Date };
const ticketId = (ticket: string) =>
  PREFIX + createHash('sha256').update(ticket).digest('hex');

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

export async function createHandoff(request: Request, session: HandoffSession) {
  const origin = requestOrigin(request);
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
        like(schema.verification.id, `${PREFIX}%`),
        lt(schema.verification.expiresAt, now),
      ),
    );
  await db.insert(schema.verification).values({
    id: ticketId(ticket),
    identifier: PREFIX + session.id,
    value: JSON.stringify({
      sessionId: session.id,
      origin,
    }),
    expiresAt,
  });
  return {
    url: `${origin}/api/auth/handoffs/consume`,
    ticket,
    expiresAt: expiresAt.toISOString(),
    completionUrl: new URL(COMPLETION_PATH, origin).href,
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
        eq(schema.verification.id, ticketId(params.get('ticket')!)),
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
  const parsed = payloadSchema.safeParse(storedPayload);
  if (
    !parsed.success ||
    parsed.data.origin !== origin ||
    record.identifier !== PREFIX + parsed.data.sessionId
  )
    throw new AppError('Invalid handoff', 403);
  const payload = parsed.data;
  const session = await db.query.session.findFirst({
    where: { id: payload.sessionId, expiresAt: { gt: new Date() } },
  });
  if (!session) throw new AppError('Session has ended', 401);
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
      location: COMPLETION_PATH,
      'set-cookie': `${cookie.name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

async function completeHandoff(request: Request) {
  requestOrigin(request);
  // Completion proves the browser stored a cookie, not just a native Bearer.
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: request.headers.get('cookie') ?? '' }),
  });
  if (!session) throw new AppError('Session has ended', 401);
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title></head><body><main><h1>Signed in</h1><p>You can continue in the app.</p></main></body></html>',
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      },
    },
  );
}

async function handleRequest(
  request: Request,
  method: 'GET' | 'POST',
  handler: (request: Request) => Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    if (request.method !== method) {
      response = new Response('Method not allowed', {
        status: 405,
        headers: { allow: method },
      });
    } else {
      response = await handler(request);
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

/** Native auth transport: a form POST and redirect cannot be a unary RPC. */
export function handleHandoffRequest(request: Request): Promise<Response> {
  return handleRequest(request, 'POST', consumeHandoff);
}

export function handleHandoffCompletion(request: Request): Promise<Response> {
  return handleRequest(request, 'GET', completeHandoff);
}
