/**
 * Server functions for the notification center Web UI.
 *
 * NOTE: this module is import-reachable from client code (`~queries/...`), so
 * it exports only server functions and types; every domain call lives inside
 * a handler and is delegated to `./notifications/service`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import {
  apnsStatus,
  createChannel,
  createGroup,
  createRoute,
  createWebhook,
  deleteChannel,
  deleteDestination,
  deleteGroup,
  deleteRoute,
  getNotification,
  listChannels,
  listDestinations,
  listGroups,
  listNotificationSources,
  listNotifications,
  listRoutes,
  retryDelivery,
  rotateChannelToken,
  rotateWebhookSecret,
  sendTestNotification,
  updateChannel,
  updateDestination,
  updateGroup,
  updateRoute,
} from './notifications/service';
import { idSchema } from './validation';
import type { JsonObject } from '~/db/schema';
import type { NotificationDetailView } from './notifications/service';

/** Notification detail with its JSON data typed for serialization. */
export type NotificationDetail = Omit<NotificationDetailView, 'data'> & {
  data: JsonObject | null;
};

export type {
  ApnsStatusView,
  ChannelView,
  DeliveryView,
  DestinationView,
  GroupView,
  NotificationDetailView,
  NotificationSourcesView,
  NotificationStatus,
  NotificationSummaryView,
  RouteView,
} from './notifications/service';

const shortText = z.string().max(200);
const kindsSchema = z
  .array(
    z.object({
      kind: z.string().max(64),
      name: z.string().max(80),
      description: z.string().max(500).optional(),
    }),
  )
  .max(100);

const listInputSchema = z.object({
  sourceType: z.enum(['app', 'channel', 'platform']).optional(),
  sourceId: idSchema.optional(),
  kind: z.string().max(64).optional(),
  status: z
    .enum(['unrouted', 'pending', 'delivered', 'partial', 'failed'])
    .optional(),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listNotificationsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof listInputSchema>) =>
    listInputSchema.parse(input),
  )
  .handler(({ data }) => listNotifications(data));

export const getNotificationFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }): Promise<NotificationDetail> => {
    const detail = await getNotification(data);
    // Stored notification data is always a JSON object (validated on ingest).
    return { ...detail, data: detail.data as JsonObject | null };
  });

export const retryDeliveryFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((deliveryId: string) => idSchema.parse(deliveryId))
  .handler(async ({ data }) => {
    await retryDelivery(data);
    return { ok: true as const };
  });

export const sendTestNotificationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((destinationId: string) => idSchema.parse(destinationId))
  .handler(({ data }) => sendTestNotification(data));

export const listNotificationSourcesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listNotificationSources());

export const getApnsStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => apnsStatus());

/** ================== destinations ================== */

export const listDestinationsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listDestinations());

const createWebhookSchema = z.object({
  name: shortText,
  url: z.string().max(2048),
});

export const createWebhookFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof createWebhookSchema>) =>
    createWebhookSchema.parse(input),
  )
  .handler(({ data }) => createWebhook(data));

const updateDestinationSchema = z.object({
  id: idSchema,
  name: shortText.optional(),
  enabled: z.boolean().optional(),
  url: z.string().max(2048).optional(),
});

export const updateDestinationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateDestinationSchema>) =>
    updateDestinationSchema.parse(input),
  )
  .handler(({ data }) => updateDestination(data));

export const rotateWebhookSecretFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => ({ secret: await rotateWebhookSecret(data) }));

export const deleteDestinationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteDestination(data);
    return { ok: true as const };
  });

/** ================== groups ================== */

export const listGroupsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listGroups());

const groupSchema = z.object({
  name: shortText,
  description: z.string().max(500).nullable().optional(),
  destinationIds: z.array(idSchema).max(200).optional(),
});

export const createGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof groupSchema>) => groupSchema.parse(input))
  .handler(({ data }) => createGroup(data));

const updateGroupSchema = groupSchema.partial().extend({ id: idSchema });

export const updateGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateGroupSchema>) =>
    updateGroupSchema.parse(input),
  )
  .handler(({ data }) => updateGroup(data));

export const deleteGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteGroup(data);
    return { ok: true as const };
  });

/** ================== routes ================== */

export const listRoutesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listRoutes());

const routeSchema = z.object({
  name: shortText.nullable().optional(),
  sourceType: z.enum(['app', 'channel', 'any']),
  sourceId: idSchema.nullable().optional(),
  kind: z.string().max(64).nullable().optional(),
  targetType: z.enum(['group', 'destination']),
  targetId: idSchema,
  enabled: z.boolean().optional(),
});

export const createRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof routeSchema>) => routeSchema.parse(input))
  .handler(({ data }) => createRoute(data));

const updateRouteSchema = routeSchema.partial().extend({ id: idSchema });

export const updateRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateRouteSchema>) =>
    updateRouteSchema.parse(input),
  )
  .handler(({ data }) => updateRoute(data));

export const deleteRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteRoute(data);
    return { ok: true as const };
  });

/** ================== channels ================== */

export const listChannelsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listChannels());

const channelSchema = z.object({
  name: shortText,
  description: z.string().max(500).nullable().optional(),
  kinds: kindsSchema,
});

export const createChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof channelSchema>) =>
    channelSchema.parse(input),
  )
  .handler(({ data }) => createChannel(data));

const updateChannelSchema = channelSchema
  .partial()
  .extend({ id: idSchema, enabled: z.boolean().optional() });

export const updateChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateChannelSchema>) =>
    updateChannelSchema.parse(input),
  )
  .handler(({ data }) => updateChannel(data));

export const rotateChannelTokenFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => ({ token: await rotateChannelToken(data) }));

export const deleteChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteChannel(data);
    return { ok: true as const };
  });
