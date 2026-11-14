/**
 * Durable notification delivery loop.
 *
 * Deliveries are claimed with `FOR UPDATE SKIP LOCKED` and a lease, so a
 * crashed worker's rows become claimable again once the lease expires and
 * concurrent platform processes never deliver the same attempt twice.
 */
import { and, eq, gt, notExists, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import { publishPlatformEvent } from '~server/platform-events';
import type { NotificationRecord } from './contract';
import { MAX_DELIVERY_RESULT } from './contract';
import type { DeliveryAdapter, DeliveryOutcome } from './delivery';

export const MAX_DELIVERY_ATTEMPTS = 6;
/** Delay before attempt n+1 after attempt n failed (n = 1..5). */
export const RETRY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;
const LEASE_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 5_000;
/** Devices that receive nothing still disappear once their session ends. */
const DEVICE_PRUNE_INTERVAL_MS = 60 * 60_000;
const CONCURRENCY = 8;
const MAX_ERROR_LENGTH = 1000;

export type DeliveryAdapters = Record<
  'device' | 'webhook' | 'app',
  DeliveryAdapter
>;

type DispatcherState = {
  adapters: DeliveryAdapters;
  active: number;
  timer: ReturnType<typeof setInterval> | null;
  pruneTimer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  again: boolean;
};

type DispatcherGlobal = typeof globalThis & {
  __hatchNotificationDispatcher__?: DispatcherState;
};

function state(): DispatcherState | undefined {
  return (globalThis as DispatcherGlobal).__hatchNotificationDispatcher__;
}

export function retryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1];
}

type ClaimedDelivery = { id: string; attempts: number };

/** Claim up to `limit` due deliveries, leasing them to this worker. */
export async function claimDueDeliveries(
  limit: number,
): Promise<ClaimedDelivery[]> {
  if (limit <= 0) return [];
  const leaseSeconds = Math.round(LEASE_MS / 1000);
  const rows = await db.execute<{ id: string; attempts: number }>(sql`
    update notification_deliveries
    set status = 'in_progress',
        attempts = attempts + 1,
        lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
        updated_at = now()
    where id in (
      select id from notification_deliveries
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'in_progress' and lease_expires_at < now())
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, attempts
  `);
  // postgres-js returns a row list; the PGlite test driver wraps it in `rows`.
  const list: unknown = Array.isArray(rows)
    ? rows
    : (rows as unknown as { rows: unknown[] }).rows;
  return (list as { id: unknown; attempts: unknown }[]).map((row) => ({
    id: String(row.id),
    attempts: Number(row.attempts),
  }));
}

/**
 * Delete device destinations whose sign-in session has ended (one, or all).
 *
 * A device lives only as long as its session, but Better Auth deletes an
 * expired session only when it is presented again. A phone the user replaced
 * or wiped never presents it, so the session cascade alone would keep that
 * device, its routes and its group memberships forever.
 */
export async function pruneEndedDeviceDestinations(
  destinationId?: string,
): Promise<number> {
  const destinations = schema.notificationDestinations;
  const removed = await db
    .delete(destinations)
    .where(
      and(
        eq(destinations.type, 'device'),
        destinationId ? eq(destinations.id, destinationId) : undefined,
        notExists(
          db
            .select({ id: schema.session.id })
            .from(schema.session)
            .where(
              and(
                eq(schema.session.id, destinations.sessionId),
                gt(schema.session.expiresAt, new Date()),
              ),
            ),
        ),
      ),
    )
    .returning({ id: destinations.id });
  return removed.length;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Persist one attempt's outcome, guarded against a lease taken over since. */
export async function recordOutcome(
  claimed: ClaimedDelivery,
  outcome: DeliveryOutcome,
  destinationId: string | null,
): Promise<void> {
  const now = new Date();
  const guard = and(
    eq(schema.notificationDeliveries.id, claimed.id),
    eq(schema.notificationDeliveries.status, 'in_progress'),
    eq(schema.notificationDeliveries.attempts, claimed.attempts),
  );
  const delay =
    outcome.kind === 'retry' ? retryDelayMs(claimed.attempts) : null;
  const error =
    outcome.kind === 'success'
      ? null
      : truncate(outcome.error, MAX_ERROR_LENGTH);
  const updated = await db
    .update(schema.notificationDeliveries)
    .set(
      outcome.kind === 'success'
        ? {
            status: 'succeeded',
            leaseExpiresAt: null,
            completedAt: now,
            lastError: null,
            httpStatus: outcome.httpStatus ?? null,
            result:
              outcome.result === undefined || outcome.result === null
                ? null
                : truncate(outcome.result, MAX_DELIVERY_RESULT),
          }
        : delay !== null
          ? {
              status: 'pending',
              leaseExpiresAt: null,
              nextAttemptAt: new Date(now.getTime() + delay),
              lastError: error,
              httpStatus: outcome.httpStatus ?? null,
            }
          : {
              status: 'failed',
              leaseExpiresAt: null,
              completedAt: now,
              lastError: error,
              httpStatus: outcome.httpStatus ?? null,
            },
    )
    .where(guard)
    .returning({
      notificationId: schema.notificationDeliveries.notificationId,
    });

  if (destinationId && outcome.destination?.remove) {
    await pruneEndedDeviceDestinations(destinationId);
  } else if (destinationId && outcome.destination) {
    await db
      .update(schema.notificationDestinations)
      .set({
        ...(outcome.destination.disable
          ? { enabled: false, disabledReason: 'unregistered' as const }
          : {}),
        ...(outcome.destination.lastError !== undefined
          ? { lastError: outcome.destination.lastError }
          : {}),
      })
      .where(
        and(
          eq(schema.notificationDestinations.id, destinationId),
          outcome.destination.ifApnsToken
            ? eq(
                schema.notificationDestinations.apnsToken,
                outcome.destination.ifApnsToken,
              )
            : undefined,
        ),
      );
  }

  const row = updated[0];
  if (row) {
    publishPlatformEvent({
      type: 'notification.delivery.updated',
      notificationId: row.notificationId,
      deliveryId: claimed.id,
    });
  }
}

/** Load everything one attempt needs, then run the matching adapter. */
export async function runClaimedDelivery(
  claimed: ClaimedDelivery,
  adapters: DeliveryAdapters,
): Promise<void> {
  const delivery = await db.query.notificationDeliveries.findFirst({
    where: { id: claimed.id },
  });
  if (!delivery) return;
  if (claimed.attempts > MAX_DELIVERY_ATTEMPTS) {
    await recordOutcome(
      claimed,
      { kind: 'fail', error: 'Delivery exceeded its attempt budget.' },
      null,
    );
    return;
  }

  let outcome: DeliveryOutcome;
  try {
    const [notification, destination] = await Promise.all([
      db.query.notifications.findFirst({
        where: { id: delivery.notificationId },
      }),
      delivery.destinationId
        ? db.query.notificationDestinations.findFirst({
            where: { id: delivery.destinationId },
          })
        : Promise.resolve(undefined),
    ]);
    if (!notification) return;
    if (!destination) {
      outcome = { kind: 'fail', error: 'Destination was removed.' };
    } else if (!destination.enabled) {
      outcome = { kind: 'fail', error: 'Destination is disabled.' };
    } else {
      const sourceSlug = notification.appId
        ? ((
            await db.query.apps.findFirst({
              where: { id: notification.appId },
              columns: { slug: true },
            })
          )?.slug ?? null)
        : null;
      outcome = await adapters[destination.type]({
        deliveryId: delivery.id,
        attempt: claimed.attempts,
        notification: notification as NotificationRecord,
        destination,
        sourceSlug,
      });
    }
  } catch (error) {
    outcome = {
      kind: 'retry',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await recordOutcome(claimed, outcome, delivery.destinationId);
}

async function tick(current: DispatcherState): Promise<void> {
  if (current.ticking) {
    current.again = true;
    return;
  }
  current.ticking = true;
  try {
    do {
      current.again = false;
      const claimed = await claimDueDeliveries(CONCURRENCY - current.active);
      for (const delivery of claimed) {
        current.active += 1;
        void runClaimedDelivery(delivery, current.adapters)
          .catch((error) => {
            console.error('Notification delivery failed unexpectedly.', error);
          })
          .finally(() => {
            current.active -= 1;
            void tick(current);
          });
      }
      if (claimed.length === 0) break;
    } while (current.again && current.active < CONCURRENCY);
  } catch (error) {
    console.error('Notification dispatcher tick failed.', error);
  } finally {
    current.ticking = false;
  }
}

/** Start the process-wide dispatcher once; safe to call repeatedly. */
export function ensureNotificationDispatcher(adapters: DeliveryAdapters): void {
  const global = globalThis as DispatcherGlobal;
  const existing = global.__hatchNotificationDispatcher__;
  if (existing) {
    existing.adapters = adapters;
    return;
  }
  const current: DispatcherState = {
    adapters,
    active: 0,
    timer: null,
    pruneTimer: null,
    ticking: false,
    again: false,
  };
  global.__hatchNotificationDispatcher__ = current;
  current.timer = setInterval(() => void tick(current), POLL_INTERVAL_MS);
  current.timer.unref?.();
  const prune = () =>
    void pruneEndedDeviceDestinations().catch((error) => {
      console.error('Pruning ended device destinations failed.', error);
    });
  current.pruneTimer = setInterval(prune, DEVICE_PRUNE_INTERVAL_MS);
  current.pruneTimer.unref?.();
  prune();
  void tick(current);
}

/** Ask the dispatcher to look for due work now (no-op before it starts). */
export function wakeNotificationDispatcher(): void {
  const current = state();
  if (current) void tick(current);
}
