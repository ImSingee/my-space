import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { auth } from '~auth/server';
import { requireSession } from './auth';

/** Session credentials stay on the server; the browser manages opaque IDs. */
export const listAccountSessions = createServerFn({ method: 'GET' }).handler(
  async () => {
    const current = await requireSession();
    const sessions = await auth.api.listSessions({
      headers: getRequest().headers,
    });
    return {
      items: sessions
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        )
        .map((session) => ({
          id: session.id,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          ipAddress: session.ipAddress?.trim() || null,
          userAgent: session.userAgent?.trim() || null,
          isCurrent: session.id === current.session.id,
        })),
    };
  },
);

export const revokeAccountSession = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ sessionId: z.string().min(1).max(255) }))
  .handler(async ({ data: { sessionId } }) => {
    const current = await requireSession();
    if (sessionId === current.session.id) {
      throw new Error('The current session cannot be signed out here.');
    }
    const sessions = await auth.api.listSessions({
      headers: getRequest().headers,
    });
    const target = sessions.find((session) => session.id === sessionId);
    // Missing or already revoked IDs are idempotent and reveal no ownership.
    if (target) {
      await auth.api.revokeSession({
        headers: getRequest().headers,
        body: { token: target.token },
      });
    }
    return { success: true as const };
  });
