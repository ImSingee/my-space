import { inArray, lt } from 'drizzle-orm';
import { db, schema } from '~/db';

const SWEEP_INTERVAL_MS = 60_000;
const BATCH_SIZE = 1_000;

/** Expiry invalidates a challenge; it does not delete its database row. */
export async function pruneExpiredVerifications(): Promise<number> {
  const cutoff = new Date();
  let deleted = 0;

  for (;;) {
    const expired = db
      .select({ id: schema.verification.id })
      .from(schema.verification)
      .where(lt(schema.verification.expiresAt, cutoff))
      .orderBy(schema.verification.expiresAt)
      .limit(BATCH_SIZE)
      // Another instance or an in-flight verification may own a row. Skip it
      // for this pass instead of holding up authentication or another sweeper.
      .for('update', { skipLocked: true });
    const rows = await db
      .delete(schema.verification)
      .where(inArray(schema.verification.id, expired))
      .returning({ id: schema.verification.id });

    deleted += rows.length;
    if (rows.length < BATCH_SIZE) return deleted;
  }
}

type CleanupState = {
  timer: ReturnType<typeof setInterval>;
  running?: Promise<void>;
  stop: () => Promise<void>;
};

type CleanupGlobal = typeof globalThis & {
  __hatchVerificationCleanup__?: CleanupState;
};

/** Start after migrations, once per process, including across dev reloads. */
export function ensureVerificationCleanup(): () => Promise<void> {
  const g = globalThis as CleanupGlobal;
  if (g.__hatchVerificationCleanup__) {
    return g.__hatchVerificationCleanup__.stop;
  }

  const sweep = () => {
    if (state.running) return;
    state.running = pruneExpiredVerifications()
      .then(() => {})
      .catch((error) => {
        console.error('[auth] verification cleanup failed:', error);
      })
      .finally(() => {
        state.running = undefined;
      });
  };
  const state: CleanupState = {
    timer: setInterval(sweep, SWEEP_INTERVAL_MS),
    stop: async () => {
      clearInterval(state.timer);
      await state.running;
      if (g.__hatchVerificationCleanup__ === state) {
        delete g.__hatchVerificationCleanup__;
      }
    },
  };
  state.timer.unref?.();
  g.__hatchVerificationCleanup__ = state;
  sweep();
  return state.stop;
}
