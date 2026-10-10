import { createHash } from 'node:crypto';
import { lt, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import { AuthError } from './credentials';

/** Shared PostgreSQL budgets, independent of untrusted forwarded-IP headers. */
export async function authRateLimit(
  action: string,
  actor = 'anonymous',
  maximum = 60,
) {
  const now = Date.now();
  const bucket = `${action}:${createHash('sha256').update(actor).digest('hex')}:${Math.floor(now / 60000)}`;
  const [row] = await db
    .insert(schema.cliAuthLimits)
    .values({ bucket, count: 1, expiresAt: new Date(now + 120000) })
    .onConflictDoUpdate({
      target: schema.cliAuthLimits.bucket,
      set: { count: sql`${schema.cliAuthLimits.count} + 1` },
    })
    .returning();
  await db
    .delete(schema.cliAuthLimits)
    .where(lt(schema.cliAuthLimits.expiresAt, new Date(now)));
  if (row.count > maximum) throw new AuthError('rate_limited', 429);
}
