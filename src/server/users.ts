/**
 * Server functions for the Users settings panel and the login page.
 *
 * The platform stays single-tenant by design: every signed-in user is a full
 * owner (see `authMiddleware`), so "user management" is intentionally small —
 * toggle whether sign-up is open, list accounts, and remove an account. New
 * users are always created through the normal Better Auth sign-up flow, never
 * from this panel.
 *
 * NOTE: this module is import-reachable from client code (login page,
 * `~queries/users`), so it must only export server functions and types.
 * Anything that touches `db` outside a handler belongs in `users-store.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { db } from '~/db';
import { authMiddleware, requireSession } from './auth';
import { getPlatformConfig, setPlatformConfig } from './platform-config';
import { idSchema } from './validation';

export type PlatformUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UsersPanelData = {
  users: PlatformUser[];
  /** Id of the caller's account, so the UI can mark it and block self-delete. */
  currentUserId: string;
  allowSignup: boolean;
};

/**
 * PUBLIC (no auth): whether self-service sign-up is currently open. The login
 * page uses it to decide whether to offer the "Create account" flow. It leaks
 * nothing an anonymous visitor couldn't learn by attempting to sign up.
 */
export const getSignupConfig = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ allowSignup: boolean }> => ({
    allowSignup: await getPlatformConfig('auth.allowSignup'),
  }),
);

export const getUsersPanelData = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<UsersPanelData> => {
    const session = await requireSession();
    const [users, allowSignup] = await Promise.all([
      db.query.user.findMany({
        orderBy: (u, { asc }) => [asc(u.createdAt), asc(u.id)],
      }),
      getPlatformConfig('auth.allowSignup'),
    ]);
    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: u.emailVerified,
        image: u.image ?? null,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      })),
      currentUserId: session.user.id,
      allowSignup,
    };
  });

export const updateAllowSignup = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { allowSignup: boolean }) =>
    z.object({ allowSignup: z.boolean() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ allowSignup: boolean }> => {
    await setPlatformConfig('auth.allowSignup', data.allowSignup);
    return { allowSignup: data.allowSignup };
  });

export const deleteUser = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { userId: string }) =>
    z.object({ userId: idSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<void> => {
    const session = await requireSession();
    const { removePlatformUser } = await import('./users-store');
    await removePlatformUser(data.userId, session.user.id);
  });
