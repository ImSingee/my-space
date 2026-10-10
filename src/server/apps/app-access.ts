import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '~auth/server';
import { db, schema } from '~/db';
import { decryptEnvelope, encryptEnvelope } from '../crypto/envelope';
import { activeAppService } from './tailscale-services';

const LOGIN_COOKIE = '__Host-hatch-app-login';
const ACCESS_COOKIE = '__Host-hatch-app-access';
const opaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const loginSchema = z.object({
  nonce: opaqueSchema,
  returnPath: z.string(),
  expires: z.number(),
});
const accessSchema = z.object({ sessionId: z.string().min(1).max(128) });
export type AppAccessBinding = {
  appId: string;
  origin: string;
  revision: string;
};
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
const context = (binding: AppAccessBinding, purpose: string) => ({
  label: 'App access',
  domain: `hatch/app-access/${purpose}/v1`,
  aad: JSON.stringify([binding.appId, binding.origin, binding.revision]),
  maxPlaintextBytes: 8192,
});
export function sealAppAccess(
  binding: AppAccessBinding,
  purpose: string,
  value: unknown,
) {
  return encryptEnvelope(JSON.stringify(value), context(binding, purpose));
}
export function openAppAccess(
  binding: AppAccessBinding,
  purpose: string,
  value: string,
) {
  return JSON.parse(
    decryptEnvelope(value, context(binding, purpose)),
  ) as unknown;
}
export function safeAppReturnPath(value: string | null): string | null {
  if (
    !value ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    value.startsWith('//')
  )
    return null;
  try {
    const url = new URL(value, 'https://app.invalid');
    if (
      url.origin !== 'https://app.invalid' ||
      url.pathname.startsWith('/__hatch/')
    )
      return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
function cookie(request: Request, name: string) {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(name + '='))
      ?.slice(name.length + 1) ?? ''
  );
}
function setCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const safeHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};
function redirect(url: string, headers?: HeadersInit) {
  return new Response(null, {
    status: 303,
    headers: { ...safeHeaders, location: url, ...headers },
  });
}
export async function hasAppAccess(
  request: Request,
  binding: AppAccessBinding,
) {
  try {
    const value = accessSchema.parse(
      openAppAccess(binding, 'session', cookie(request, ACCESS_COOKIE)),
    );
    const session = await db.query.session.findFirst({
      where: { id: value.sessionId, expiresAt: { gt: new Date() } },
      columns: { id: true },
    });
    return Boolean(session);
  } catch {
    return false;
  }
}
/** Bootstrap preserves browser-only fragments before starting the server handoff. */
export function appLoginPage(request: Request) {
  const url = new URL(request.url);
  const path = safeAppReturnPath(url.pathname + url.search) ?? '/';
  const target = `/__hatch/auth/start?return=${encodeURIComponent(path)}`;
  const cspNonce = randomBytes(18).toString('base64url');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in to Hatch</title><body><p>Continuing to Hatch to confirm your session…</p><a href="${target.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Continue to sign in</a><script nonce="${cspNonce}">location.replace('/__hatch/auth/start?return='+encodeURIComponent(location.pathname+location.search+location.hash));</script></body></html>`,
    {
      headers: {
        ...safeHeaders,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${cspNonce}'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
export async function startAppAccess(
  request: Request,
  binding: AppAccessBinding,
  platformOrigin: string,
) {
  const returnPath = safeAppReturnPath(
    new URL(request.url).searchParams.get('return'),
  );
  if (!returnPath)
    return new Response('Invalid return path', {
      status: 400,
      headers: safeHeaders,
    });
  const nonce = randomBytes(32).toString('base64url');
  const state = sealAppAccess(binding, 'login', {
    nonce,
    returnPath,
    expires: Date.now() + 600_000,
  });
  const target = new URL('/__hatch/app-access', platformOrigin);
  target.search = new URLSearchParams({
    appId: binding.appId,
    origin: binding.origin,
    challenge: digest(nonce),
    return: returnPath,
  }).toString();
  return redirect(target.href, {
    'set-cookie': setCookie(LOGIN_COOKIE, state, 600),
  });
}
export async function authorizeAppAccess(
  request: Request,
  platformOrigin: string,
) {
  const url = new URL(request.url);
  const appId = url.searchParams.get('appId') ?? '';
  const origin = url.searchParams.get('origin') ?? '';
  const challenge = opaqueSchema.safeParse(url.searchParams.get('challenge'));
  const returnPath = safeAppReturnPath(url.searchParams.get('return'));
  const active = await activeAppService(appId, origin);
  if (!active || !challenge.success || !returnPath)
    return new Response('Invalid App entry', {
      status: 400,
      headers: safeHeaders,
    });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const target = new URL('/login', platformOrigin);
    target.searchParams.set('redirect', url.pathname + url.search);
    return redirect(target.href);
  }
  const code = randomBytes(32).toString('base64url');
  await db.insert(schema.appAccessCodes).values({
    digest: digest(code),
    appId,
    origin,
    revision: active.binding.revision,
    challenge: challenge.data,
    returnPath,
    sessionId: session.session.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const target = new URL('/__hatch/auth/callback', origin);
  target.searchParams.set('code', code);
  return redirect(target.href);
}
export async function finishAppAccess(
  request: Request,
  binding: AppAccessBinding,
) {
  const code = opaqueSchema.safeParse(
    new URL(request.url).searchParams.get('code'),
  );
  try {
    const login = loginSchema.parse(
      openAppAccess(binding, 'login', cookie(request, LOGIN_COOKIE)),
    );
    if (!code.success || login.expires <= Date.now())
      throw new Error('Expired handoff');
    const [row] = await db
      .delete(schema.appAccessCodes)
      .where(
        and(
          eq(schema.appAccessCodes.digest, digest(code.data)),
          eq(schema.appAccessCodes.appId, binding.appId),
          eq(schema.appAccessCodes.origin, binding.origin),
          eq(schema.appAccessCodes.revision, binding.revision),
          eq(schema.appAccessCodes.challenge, digest(login.nonce)),
          eq(schema.appAccessCodes.returnPath, login.returnPath),
          gt(schema.appAccessCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!row) throw new Error('Invalid handoff');
    const parent = await db.query.session.findFirst({
      where: { id: row.sessionId, expiresAt: { gt: new Date() } },
      columns: { expiresAt: true },
    });
    if (!parent) throw new Error('Expired parent session');
    const value = sealAppAccess(binding, 'session', {
      sessionId: row.sessionId,
    });
    const response = redirect(new URL(login.returnPath, binding.origin).href);
    response.headers.append('set-cookie', setCookie(LOGIN_COOKIE, '', 0));
    response.headers.append(
      'set-cookie',
      setCookie(
        ACCESS_COOKIE,
        value,
        Math.max(
          0,
          Math.floor((parent.expiresAt.getTime() - Date.now()) / 1000),
        ),
      ),
    );
    return response;
  } catch {
    return new Response(
      'This sign-in link expired or belongs to a different browser. Open the App again to sign in.',
      { status: 400, headers: safeHeaders },
    );
  }
}
export async function purgeAppAccessCodes() {
  await db
    .delete(schema.appAccessCodes)
    .where(
      and(
        lt(schema.appAccessCodes.expiresAt, new Date()),
        sql`${schema.appAccessCodes.digest} in (select digest from app_access_codes where expires_at < now() limit 1000)`,
      ),
    );
}
