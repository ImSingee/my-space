import { z } from 'zod';
import { keyRequestSchema } from '~auth/cli-policy';
import { getPlatformEnv } from '~env';
import {
  AuthError,
  cookieSession,
  issueCredential,
  listKeys,
  resolveCredential,
  revokeOwnedKey,
  rotateOwnedKey,
} from './credentials';
import { authRateLimit } from './rate-limit';
import {
  cancelDevice,
  claimDevice,
  createDevice,
  decideDevice,
  redeemDevice,
} from './device';

const codeBody = z.object({ user_code: z.string().min(1).max(32) }).strict();
const tokenBody = z
  .object({
    client_id: z.literal('hatch-cli'),
    device_code: z.string().min(1).max(191),
  })
  .strict();
export const safeJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
export async function readAuthBody(request: Request, limit = 16384) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new AuthError('json_required', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('invalid_request', 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AuthError('payload_too_large', 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('invalid_json', 400);
  }
}

export async function handleCliAuthRequest(
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.origin !== getPlatformEnv().appUrl)
      throw new AuthError('instance_origin_mismatch', 400);
    const path = url.pathname.slice('/api/cli/v1/'.length).split('/');
    const method = request.method;
    if (method === 'GET' && path.join('/') === 'instance') {
      return safeJson({
        url: getPlatformEnv().appUrl,
        authentication: 'opaque_key',
      });
    }
    if (path[0] !== 'auth') {
      const { handleLifecycleRequest } = await import('./lifecycle');
      return await handleLifecycleRequest(request, path);
    }
    const action = path.slice(1).join('/');
    if (action === 'status' && method === 'GET')
      return safeJson(await resolveCredential(request));
    if (action === 'revoke-self' && method === 'POST') {
      const principal = await resolveCredential(request);
      if (principal.credentialType === 'run_key')
        throw new AuthError('host_managed_credential', 403);
      await revokeOwnedKey(principal.userId, principal.credentialId);
      return safeJson({ revoked: true });
    }
    if (action === 'device' && method === 'POST') {
      authRateLimit('device-create');
      return safeJson(await createDevice(await readAuthBody(request)));
    }
    if (action === 'device/token' && method === 'POST') {
      const { device_code } = tokenBody.parse(await readAuthBody(request));
      const result = await redeemDevice(device_code);
      return safeJson(result, 'error' in result ? 400 : 200);
    }
    if (action === 'device/cancel' && method === 'POST') {
      const { device_code } = tokenBody.parse(await readAuthBody(request));
      return safeJson(await cancelDevice(device_code));
    }
    if (
      ['device/claim', 'device/approve', 'device/deny'].includes(action) &&
      method === 'POST'
    ) {
      const session = await cookieSession(request);
      authRateLimit(action, session.user.id);
      const { user_code } = codeBody.parse(await readAuthBody(request));
      return safeJson(
        action === 'device/claim'
          ? await claimDevice(user_code, session)
          : await decideDevice(user_code, session, action === 'device/approve'),
      );
    }
    if (action === 'keys' && method === 'GET') {
      const session = await cookieSession(request, false);
      return safeJson(await listKeys(session.user.id));
    }
    if (action === 'keys' && method === 'POST') {
      const session = await cookieSession(request);
      authRateLimit(action, session.user.id);
      const input = keyRequestSchema.parse(await readAuthBody(request));
      return safeJson(
        await issueCredential({
          ...input,
          userId: session.user.id,
          credentialType: 'user_api_key',
        }),
      );
    }
    if (
      path.length === 4 &&
      path[1] === 'keys' &&
      ['rotate', 'revoke'].includes(path[3]) &&
      method === 'POST'
    ) {
      const session = await cookieSession(request);
      authRateLimit(action, session.user.id);
      const id = decodeURIComponent(path[2]);
      if (path[3] === 'revoke') {
        await revokeOwnedKey(session.user.id, id);
        return safeJson({ revoked: true });
      }
      const { expiresIn } = z
        .object({
          expiresIn: z
            .number()
            .int()
            .min(300)
            .max(90 * 86400),
        })
        .strict()
        .parse(await readAuthBody(request));
      return safeJson(await rotateOwnedKey(session.user.id, id, expiresIn));
    }
    throw new AuthError('not_found', 404);
  } catch (error) {
    return authErrorResponse(error);
  }
}
export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError)
    return safeJson({ error: error.code }, error.status);
  if (error instanceof z.ZodError)
    return safeJson({ error: 'invalid_request' }, 400);
  // Never return exception text, plugin payloads or database parameters to callers/logs.
  return safeJson({ error: 'internal_error' }, 500);
}
