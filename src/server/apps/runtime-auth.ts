import { auth } from '~auth/server';

const appRequests = new WeakMap<
  Request,
  { appId: string; authenticated: boolean }
>();
/** Only the verified ingress handler can mark an App-scoped request. */
export function markAppRuntimeRequest(
  request: Request,
  appId: string,
  authenticated = true,
) {
  appRequests.set(request, { appId, authenticated });
}
export async function authorizeAppRuntimeRequest(
  request: Request,
  appId: string,
): Promise<boolean> {
  const scoped = appRequests.get(request);
  if (scoped !== undefined) {
    if (scoped.appId !== appId || !scoped.authenticated) return false;
    const origin = request.headers.get('origin');
    return !origin || origin === new URL(request.url).origin;
  }
  return Boolean(await auth.api.getSession({ headers: request.headers }));
}
