import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import {
  getApnsStatusFn,
  getNotificationFn,
  listChannelsFn,
  listDestinationsFn,
  listGroupsFn,
  listNotificationSourcesFn,
  listNotificationsFn,
  listRoutesFn,
  type NotificationStatus,
} from '~server/notifications';

/** Root key: invalidating it refreshes every notification view. */
export const NOTIFICATIONS_KEY = ['notifications'] as const;

export type NotificationFilters = {
  sourceType?: 'app' | 'channel' | 'platform';
  sourceId?: string;
  kind?: string;
  status?: NotificationStatus;
};

export const notificationHistoryQueryOptions = (filters: NotificationFilters) =>
  infiniteQueryOptions({
    queryKey: [...NOTIFICATIONS_KEY, 'history', filters],
    queryFn: ({ pageParam }) =>
      listNotificationsFn({
        data: { ...filters, cursor: pageParam ?? undefined, limit: 50 },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const notificationDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...NOTIFICATIONS_KEY, 'detail', id],
    queryFn: () => getNotificationFn({ data: id }),
  });

export const notificationSourcesQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'sources'],
  queryFn: () => listNotificationSourcesFn(),
});

export const notificationDestinationsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'destinations'],
  queryFn: () => listDestinationsFn(),
});

export const notificationGroupsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'groups'],
  queryFn: () => listGroupsFn(),
});

export const notificationRoutesQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'routes'],
  queryFn: () => listRoutesFn(),
});

export const notificationChannelsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'channels'],
  queryFn: () => listChannelsFn(),
});

export const apnsStatusQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'apns'],
  queryFn: () => getApnsStatusFn(),
});
