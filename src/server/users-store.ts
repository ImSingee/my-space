/**
 * Server-only: user-account mutations behind the Users settings panel.
 *
 * Kept out of `users.ts` on purpose: that module is import-reachable from
 * client code (login page, queries), so its non-server-fn exports end up in
 * the browser bundle — and anything referencing `db` would drag the Node
 * Postgres driver into it. Server fns import this module and only reference
 * it inside handlers, which the client compilation strips.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import { AppError } from './errors';

/**
 * Delete an account. Rejects deleting the caller's own account — which also
 * guarantees at least one user always remains, since the caller must exist —
 * with an explicit last-user guard as a backstop should self-deletion or
 * non-user callers ever be introduced. Sessions and accounts are removed by
 * the FK `on delete cascade` on the Better Auth tables.
 */
export async function removePlatformUser(
  userId: string,
  currentUserId: string,
): Promise<void> {
  if (userId === currentUserId) {
    throw new AppError(
      'You cannot delete the account you are signed in with.',
      400,
    );
  }
  await db.transaction(async (tx) => {
    // FOR UPDATE serializes concurrent deletes: without it, two sessions
    // deleting each other could both count 2 users, both pass the guard, and
    // leave zero accounts. The user table is tiny, so locking every row is
    // fine; the blocked transaction re-reads after the first commits and then
    // trips the last-user guard.
    const users = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .for('update');
    if (!users.some((u) => u.id === userId)) {
      throw new AppError('User not found.', 404);
    }
    if (users.length <= 1) {
      throw new AppError('The last user cannot be deleted.', 400);
    }
    await tx.delete(schema.user).where(eq(schema.user.id, userId));
  });
}
