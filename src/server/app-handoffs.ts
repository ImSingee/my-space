import { createHash, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, like, lt } from 'drizzle-orm';
import { getCookies } from 'better-auth/cookies';
import { z } from 'zod';
import { auth } from '~auth/server';
import { db, schema } from '~/db';
import { getPlatformEnv } from '~/env';
import { isValidAppSlug } from '~server/apps/manifest';
import { AppError } from '~server/errors';
import {
  isTrustedSessionOrigin,
  sessionOriginError,
} from '~server/session-http-auth';
import { appCompatibility } from '~/app-compatibility';
import { readBoundedText } from './platform-api/body';

async function getHandoffApp(id: string) {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      id: true,
      slug: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
    },
  });
  if (!app) return null;
  const { currentDeploymentId, ...details } = app;
  const deployment = currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: currentDeploymentId },
        columns: { compatibilityVersion: true },
      })
    : null;
  return {
    ...details,
    deploymentRevision: currentDeploymentId,
    compatibility: deployment
      ? appCompatibility(deployment.compatibilityVersion)
      : null,
  };
}

const TICKET_LIFETIME_MS = 60_000;
const PREFIX = 'app-handoff:';
const payloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  appId: z.string().min(1),
  origin: z.string(),
  targetPath: z.string(),
});
const ticketId = (ticket: string) =>
  PREFIX + createHash('sha256').update(ticket).digest('hex');

function appTarget(slug: string) {
  // The target is computed from the platform App record, never client input.
  // Also reject unsafe persisted identities rather than trusting URL encoding.
  if (!isValidAppSlug(slug)) {
    throw new AppError('App cannot be opened', 409);
  }
  return `/app/${slug}/embed/`;
}

function requestOrigin(request: Request) {
  const origin = new URL(request.url).origin;
  if (!isTrustedSessionOrigin(origin))
    throw new AppError('Wrong instance origin', 403);
  return origin;
}

export async function createAppHandoff(
  request: Request,
  session: { id: string; expiresAt: Date },
  appId: string,
) {
  const app = await getHandoffApp(appId);
  if (!app) throw new AppError('App not found', 404);
  if (
    !app.deploymentRevision ||
    !app.capabilities?.frontend ||
    app.status === 'archived' ||
    !app.compatibility?.isSupported
  ) {
    throw new AppError('App is not available to open', 409);
  }
  const origin = requestOrigin(request);
  const targetPath = appTarget(app.slug);
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
    value: JSON.stringify({ sessionId: session.id, appId, origin, targetPath }),
    expiresAt,
  });
  return {
    url: `${origin}/api/v1/auth/handoffs/consume`,
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
export async function consumeAppHandoff(request: Request) {
  const originError = sessionOriginError(request);
  if (originError) throw new AppError('Cross-origin request denied', 403);
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
  const parsed = payloadSchema.safeParse(JSON.parse(record.value));
  if (!parsed.success || parsed.data.origin !== origin)
    throw new AppError('Invalid handoff', 403);
  const payload = parsed.data;
  const [session, app] = await Promise.all([
    db.query.session.findFirst({
      where: { id: payload.sessionId, expiresAt: { gt: new Date() } },
    }),
    getHandoffApp(payload.appId),
  ]);
  if (!session) throw new AppError('Session has ended', 401);
  if (
    !app ||
    appTarget(app.slug) !== payload.targetPath ||
    !app.deploymentRevision ||
    !app.capabilities?.frontend ||
    app.status === 'archived' ||
    !app.compatibility?.isSupported
  ) {
    throw new AppError('App is no longer available', 409);
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
      location: payload.targetPath,
      'set-cookie': `${cookie.name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
