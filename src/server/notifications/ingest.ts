/**
 * Accept a notification, resolve routing and enqueue one delivery per
 * destination in the same transaction, then wake the dispatcher.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema, type TX } from '~/db';
import type { NotificationKindDeclaration } from '~/db/schema';
import { publishPlatformEvent } from '~server/platform-events';
import type { NotificationPush } from './contract';
import { wakeNotificationDispatcher } from './dispatcher';

export type NotificationSource =
  | { type: 'app'; appId: string; name: string }
  | { type: 'channel'; channelId: string; name: string }
  | { type: 'platform'; name: string };

/** `deliveries` counts the deliveries queued now; 0 for a duplicate. */
export type IngestResult = {
  id: string;
  deduplicated: boolean;
  deliveries: number;
};

export function newNotificationId(): string {
  return ulid().toLowerCase();
}

type RoutableDestination = {
  id: string;
  type: 'device' | 'webhook' | 'app';
  name: string;
  appId: string | null;
};

/**
 * Destinations for one notification, keyed by destination id with the route
 * ids that selected it. Disabled routes and destinations never match, and an
 * App never receives its own notifications (the most direct feedback loop).
 */
export async function resolveRoutedDestinations(
  tx: TX,
  source: NotificationSource,
  kind: string,
): Promise<
  Map<string, { destination: RoutableDestination; routeIds: string[] }>
> {
  const result = new Map<
    string,
    { destination: RoutableDestination; routeIds: string[] }
  >();
  if (source.type === 'platform') return result;

  const routes = (
    await tx.query.notificationRoutes.findMany({
      where: { enabled: true },
    })
  ).filter((route) => {
    if (route.kind !== null && route.kind !== kind) return false;
    if (route.sourceType === 'any') return true;
    if (route.sourceType !== source.type) return false;
    if (source.type === 'app') {
      return route.appId === null || route.appId === source.appId;
    }
    return route.channelId === null || route.channelId === source.channelId;
  });
  if (routes.length === 0) return result;

  const groupIds = [
    ...new Set(
      routes.flatMap((route) =>
        route.targetGroupId ? [route.targetGroupId] : [],
      ),
    ),
  ];
  const members =
    groupIds.length === 0
      ? []
      : await tx
          .select({
            groupId: schema.notificationGroupMembers.groupId,
            destinationId: schema.notificationGroupMembers.destinationId,
          })
          .from(schema.notificationGroupMembers)
          .where(inArray(schema.notificationGroupMembers.groupId, groupIds));

  const routeIdsByDestination = new Map<string, Set<string>>();
  const addTarget = (destinationId: string, routeId: string) => {
    const set = routeIdsByDestination.get(destinationId) ?? new Set();
    set.add(routeId);
    routeIdsByDestination.set(destinationId, set);
  };
  for (const route of routes) {
    if (route.targetDestinationId) {
      addTarget(route.targetDestinationId, route.id);
      continue;
    }
    for (const member of members) {
      if (member.groupId === route.targetGroupId) {
        addTarget(member.destinationId, route.id);
      }
    }
  }
  if (routeIdsByDestination.size === 0) return result;

  const destinations = await tx.query.notificationDestinations.findMany({
    where: { id: { in: [...routeIdsByDestination.keys()] }, enabled: true },
    columns: { id: true, type: true, name: true, appId: true },
  });
  for (const destination of destinations) {
    if (
      destination.type === 'app' &&
      source.type === 'app' &&
      destination.appId === source.appId
    ) {
      continue;
    }
    result.set(destination.id, {
      destination,
      routeIds: [...(routeIdsByDestination.get(destination.id) ?? [])].sort(),
    });
  }
  return result;
}

async function findDuplicate(
  tx: TX,
  source: NotificationSource,
  dedupeKey: string,
): Promise<string | null> {
  if (source.type === 'platform') return null;
  const existing = await tx.query.notifications.findFirst({
    where:
      source.type === 'app'
        ? { appId: source.appId, dedupeKey }
        : { channelId: source.channelId, dedupeKey },
    columns: { id: true },
  });
  return existing?.id ?? null;
}

/**
 * Persist one notification and its deliveries. `onlyDestinationId` bypasses
 * routing for platform test notifications.
 */
export async function ingestNotification(args: {
  source: NotificationSource;
  kind: NotificationKindDeclaration;
  push: NotificationPush;
  onlyDestinationId?: string;
}): Promise<IngestResult> {
  const { source, kind, push } = args;
  const id = newNotificationId();
  const now = new Date();

  const outcome = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.notifications)
      .values({
        id,
        sourceType: source.type,
        appId: source.type === 'app' ? source.appId : null,
        channelId: source.type === 'channel' ? source.channelId : null,
        sourceName: source.name,
        kind: kind.kind,
        kindName: kind.name,
        title: push.title,
        body: push.body,
        url: push.url,
        data: push.data,
        dedupeKey: push.dedupeKey,
        occurredAt: push.occurredAt ? new Date(push.occurredAt) : now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.notifications.id });
    if (inserted.length === 0) {
      const duplicate = push.dedupeKey
        ? await findDuplicate(tx, source, push.dedupeKey)
        : null;
      if (!duplicate) throw new Error('Notification insert conflicted.');
      return { id: duplicate, deduplicated: true, deliveries: 0 };
    }

    let targets: Map<
      string,
      { destination: RoutableDestination; routeIds: string[] }
    >;
    if (args.onlyDestinationId) {
      const destination = await tx.query.notificationDestinations.findFirst({
        where: { id: args.onlyDestinationId },
        columns: { id: true, type: true, name: true, appId: true },
      });
      targets = new Map(
        destination ? [[destination.id, { destination, routeIds: [] }]] : [],
      );
    } else {
      targets = await resolveRoutedDestinations(tx, source, kind.kind);
    }
    if (targets.size > 0) {
      await tx.insert(schema.notificationDeliveries).values(
        [...targets.values()].map(({ destination, routeIds }) => ({
          notificationId: id,
          destinationId: destination.id,
          destinationType: destination.type,
          destinationName: destination.name,
          routeIds,
          nextAttemptAt: now,
        })),
      );
    }
    return { id, deduplicated: false, deliveries: targets.size };
  });

  if (!outcome.deduplicated) {
    publishPlatformEvent({
      type: 'notification.created',
      notificationId: outcome.id,
    });
    if (outcome.deliveries > 0) wakeNotificationDispatcher();
  }
  return outcome;
}

/** Re-queue a failed delivery for an immediate fresh attempt series. */
export async function requeueDelivery(deliveryId: string): Promise<boolean> {
  const updated = await db
    .update(schema.notificationDeliveries)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseExpiresAt: null,
      completedAt: null,
      lastError: null,
      httpStatus: null,
    })
    .where(
      and(
        eq(schema.notificationDeliveries.id, deliveryId),
        eq(schema.notificationDeliveries.status, 'failed'),
      ),
    )
    .returning({
      id: schema.notificationDeliveries.id,
      notificationId: schema.notificationDeliveries.notificationId,
    });
  const row = updated[0];
  if (!row) return false;
  publishPlatformEvent({
    type: 'notification.delivery.updated',
    notificationId: row.notificationId,
    deliveryId: row.id,
  });
  wakeNotificationDispatcher();
  return true;
}
