import {
  createMiddleware,
  createServerFn,
  createServerOnlyFn,
} from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { auth } from '~auth/server';

/**
 * Resolve the current Better Auth session on the server (SSR loaders, server
 * functions). Returns `null` when unauthenticated.
 */
export const fetchSession = createServerFn({ method: 'GET' }).handler(
  async () => {
    const request = getRequest();
    const session = await auth.api.getSession({ headers: request.headers });
    return session ?? null;
  },
);

export type AppSession = Awaited<ReturnType<typeof fetchSession>>;

/**
 * Require an authenticated session inside a server function. Throws (rejecting
 * the call) when unauthenticated. Returns the resolved session for the caller.
 *
 * Wrapped with `createServerOnlyFn` so its server-only `getRequest()` usage is
 * stripped from client bundles — `~server/auth` is import-reachable from client
 * routes (e.g. `/login` consumes {@link fetchSession}), and a plain function
 * here would drag `@tanstack/react-start/server` into the client build and fail
 * TanStack Start import protection.
 */
export const requireSession = createServerOnlyFn(async () => {
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Error('Unauthorized');
  return session;
});

/**
 * Server-function middleware that rejects unauthenticated callers.
 *
 * TanStack server functions are plain HTTP endpoints, so a route's `beforeLoad`
 * guard does NOT protect them — without this, anyone could call the data RPCs
 * directly. Attach it to every data server function (everything except the
 * public {@link fetchSession} probe used to determine auth state).
 *
 * SINGLE-TENANT BY DESIGN: the platform is one person's personal space, so
 * authentication is the only boundary — once signed in, a session can see and
 * manage everything (apps, dashboards, agent chats, providers). No table
 * carries an owner column and no query filters by user id. If multi-user
 * support is ever added, every server function behind this middleware needs
 * per-user scoping, not just this comment updated.
 */
export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    await requireSession();
    return next();
  },
);
