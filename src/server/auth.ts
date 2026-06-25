import { createServerFn } from '@tanstack/react-start';
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
