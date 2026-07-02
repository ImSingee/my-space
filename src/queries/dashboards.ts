import { queryOptions } from '@tanstack/react-query';
import {
  getDashboard,
  listAvailableWidgets,
  listDashboards,
} from '~server/dashboards';

export const dashboardsQueryOptions = queryOptions({
  queryKey: ['dashboards'],
  queryFn: () => listDashboards(),
});

export const dashboardQueryOptions = (dashboardId: string) =>
  queryOptions({
    queryKey: ['dashboard', 'widgets', dashboardId],
    queryFn: () => getDashboard({ data: dashboardId }),
  });

export const availableWidgetsQueryOptions = queryOptions({
  queryKey: ['dashboard', 'available-widgets'],
  queryFn: () => listAvailableWidgets(),
});
