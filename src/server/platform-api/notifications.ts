/** Connect adapter for the notification center management API. */
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { NotificationService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import type {
  NotificationKindDeclaration,
  NotificationRouteSourceType,
  NotificationSourceType,
} from '~/db/schema';
import {
  apnsStatus,
  createChannel,
  createGroup,
  createRoute,
  createWebhook,
  currentDevice,
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
  registerDevice,
  retryDelivery,
  rotateChannelToken,
  rotateWebhookSecret,
  sendTestNotification,
  unregisterDevice,
  updateChannel,
  updateDestination,
  updateGroup,
  updateRoute,
  type ChannelView,
  type DestinationView,
  type NotificationStatus,
  type NotificationSummaryView,
} from '~server/notifications/service';
import { sessionOriginError } from '~server/session-http-auth';
import { authenticatePublicApi } from './auth';
import { publicApiError, publicError } from './errors';
import { publicApiContext } from './context';

const none = <T>(value: T | null | undefined) => value ?? undefined;

function destination(view: DestinationView) {
  return {
    ...view,
    lastError: none(view.lastError),
    device: view.device
      ? { ...view.device, userName: none(view.device.userName) }
      : undefined,
    webhook: none(view.webhook),
    app: view.app ? { ...view.app, slug: none(view.app.slug) } : undefined,
  };
}

function kinds(list: NotificationKindDeclaration[]) {
  return list.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
  }));
}

function channel(view: ChannelView) {
  return {
    ...view,
    description: none(view.description),
    kinds: kinds(view.kinds),
  };
}

function summary(view: NotificationSummaryView) {
  return {
    ...view,
    sourceId: none(view.sourceId),
    body: none(view.body),
    url: none(view.url),
  };
}

function kindInput(
  list: { kind: string; name: string; description?: string }[],
): NotificationKindDeclaration[] {
  return list.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

function sessionOf(context: HandlerContext) {
  const auth = context.values.get(publicApiContext);
  if (auth.status?.credentialType !== 'session' || !auth.session) {
    throw publicApiError('SESSION_REQUIRED');
  }
  return { sessionId: auth.session.id, userId: auth.status.user.id };
}

export function registerNotificationApi(router: ConnectRouter) {
  // Users (session or API key) manage delivery; Run credentials never do.
  const userCredentials = {
    grpc: false,
    grpcWeb: false,
    requestGate: async (context: HandlerContext) => {
      try {
        const request = new Request(context.url, {
          headers: context.requestHeader,
        });
        if (sessionOriginError(request)) throw publicApiError('FORBIDDEN');
        const auth = await authenticatePublicApi(request);
        const type = auth.status?.credentialType;
        if (type !== 'session' && type !== 'api-key') {
          throw publicApiError('SESSION_REQUIRED');
        }
        context.values.set(publicApiContext, auth);
      } catch (error) {
        throw publicError(error);
      }
    },
  };

  router.service(
    NotificationService,
    {
      listNotifications: async (input) => {
        const page = await listNotifications({
          sourceType: input.sourceType as NotificationSourceType | undefined,
          sourceId: input.sourceId,
          kind: input.kind || undefined,
          status: input.status as NotificationStatus | undefined,
          cursor: input.cursor || undefined,
          limit: input.limit || undefined,
        });
        return {
          notifications: page.items.map(summary),
          nextCursor: none(page.nextCursor),
        };
      },
      getNotification: async (input) => {
        const detail = await getNotification(input.id);
        return {
          notification: {
            summary: summary(detail),
            dataJson: detail.data ? JSON.stringify(detail.data) : undefined,
            dedupeKey: none(detail.dedupeKey),
            deliveries: detail.deliveryList.map((delivery) => ({
              ...delivery,
              destinationId: none(delivery.destinationId),
              nextAttemptAt: none(delivery.nextAttemptAt),
              lastError: none(delivery.lastError),
              httpStatus: none(delivery.httpStatus),
              result: none(delivery.result),
              completedAt: none(delivery.completedAt),
            })),
          },
        };
      },
      retryDelivery: async (input) => {
        await retryDelivery(input.deliveryId);
        return {};
      },
      sendTestNotification: async (input) => ({
        notificationId: (await sendTestNotification(input.destinationId)).id,
      }),
      listNotificationSources: async () => {
        const sources = await listNotificationSources();
        return {
          apps: sources.apps.map((app) => ({
            ...app,
            kinds: kinds(app.kinds),
          })),
          channels: sources.channels.map((entry) => ({
            ...entry,
            kinds: kinds(entry.kinds),
          })),
        };
      },
      getApnsStatus: () => {
        const status = apnsStatus();
        return {
          ...status,
          topic: none(status.topic),
          error: none(status.error),
        };
      },

      listDestinations: async () => ({
        destinations: (await listDestinations()).map(destination),
      }),
      createWebhook: async (input) => {
        const created = await createWebhook(input);
        return {
          destination: destination(created.destination),
          secret: created.secret,
        };
      },
      updateDestination: async (input) => ({
        destination: destination(
          await updateDestination({
            id: input.id,
            name: input.name,
            enabled: input.enabled,
            url: input.url,
          }),
        ),
      }),
      rotateWebhookSecret: async (input) => ({
        secret: await rotateWebhookSecret(input.id),
      }),
      deleteDestination: async (input) => {
        await deleteDestination(input.id);
        return {};
      },

      registerDevice: async (input, context) => {
        const { sessionId, userId } = sessionOf(context);
        return {
          destination: destination(
            await registerDevice({
              sessionId,
              userId,
              name: input.name,
              platform: 'ios',
              apnsToken: input.apnsToken,
              apnsEnvironment: input.apnsEnvironment as
                | 'sandbox'
                | 'production',
              e2eKeyId: input.e2eKeyId,
              e2eKey: input.e2eKey,
            }),
          ),
        };
      },
      unregisterDevice: async (_input, context) => {
        await unregisterDevice(sessionOf(context).sessionId);
        return {};
      },
      getCurrentDevice: async (_input, context) => {
        const view = await currentDevice(sessionOf(context).sessionId);
        return { destination: view ? destination(view) : undefined };
      },

      listGroups: async () => ({
        groups: (await listGroups()).map((group) => ({
          ...group,
          description: none(group.description),
        })),
      }),
      createGroup: async (input) => {
        const group = await createGroup({
          name: input.name,
          description: input.description,
          autoAddDevices: input.autoAddDevices,
          destinationIds: input.destinationIds?.ids ?? [],
        });
        return { group: { ...group, description: none(group.description) } };
      },
      updateGroup: async (input) => {
        const group = await updateGroup({
          id: input.id,
          name: input.name,
          description: input.description,
          autoAddDevices: input.autoAddDevices,
          destinationIds: input.destinationIds?.ids,
        });
        return { group: { ...group, description: none(group.description) } };
      },
      deleteGroup: async (input) => {
        await deleteGroup(input.id);
        return {};
      },

      listRoutes: async () => ({
        routes: (await listRoutes()).map((route) => ({
          ...route,
          name: none(route.name),
          sourceId: none(route.sourceId),
          kind: none(route.kind),
        })),
      }),
      createRoute: async (input) => {
        const route = await createRoute({
          name: input.name,
          sourceType: input.sourceType as NotificationRouteSourceType,
          sourceId: input.sourceId,
          kind: input.kind,
          targetType: input.targetType as 'group' | 'destination',
          targetId: input.targetId,
          enabled: input.enabled,
        });
        return {
          route: {
            ...route,
            name: none(route.name),
            sourceId: none(route.sourceId),
            kind: none(route.kind),
          },
        };
      },
      updateRoute: async (input) => {
        const route = await updateRoute({
          id: input.id,
          name: input.name,
          sourceType: input.sourceType as
            | NotificationRouteSourceType
            | undefined,
          sourceId: input.sourceId,
          kind: input.kind,
          targetType: input.targetType as 'group' | 'destination' | undefined,
          targetId: input.targetId,
          enabled: input.enabled,
        });
        return {
          route: {
            ...route,
            name: none(route.name),
            sourceId: none(route.sourceId),
            kind: none(route.kind),
          },
        };
      },
      deleteRoute: async (input) => {
        await deleteRoute(input.id);
        return {};
      },

      listChannels: async () => ({
        channels: (await listChannels()).map(channel),
      }),
      createChannel: async (input) => {
        const created = await createChannel({
          name: input.name,
          description: input.description,
          kinds: kindInput(input.kinds?.kinds ?? []),
        });
        return { channel: channel(created.channel), token: created.token };
      },
      updateChannel: async (input) => ({
        channel: channel(
          await updateChannel({
            id: input.id,
            name: input.name,
            description: input.description,
            kinds: input.kinds ? kindInput(input.kinds.kinds) : undefined,
            enabled: input.enabled,
          }),
        ),
      }),
      rotateChannelToken: async (input) => ({
        token: await rotateChannelToken(input.id),
      }),
      deleteChannel: async (input) => {
        await deleteChannel(input.id);
        return {};
      },
    },
    userCredentials,
  );
}
