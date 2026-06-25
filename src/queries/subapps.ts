import { queryOptions } from '@tanstack/react-query';
import {
  getDashboard,
  getSubappOps,
  listAvailableWidgets,
  listDeployments,
  listSidebarItems,
  listSubapps,
} from '~server/subapps';

export const subappsQueryOptions = queryOptions({
  queryKey: ['subapps'],
  queryFn: () => listSubapps(),
});

export const dashboardQueryOptions = queryOptions({
  queryKey: ['dashboard', 'widgets'],
  queryFn: () => getDashboard(),
});

export const availableWidgetsQueryOptions = queryOptions({
  queryKey: ['dashboard', 'available-widgets'],
  queryFn: () => listAvailableWidgets(),
});

export const deploymentsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['subapps', id, 'deployments'],
    queryFn: () => listDeployments({ data: id }),
  });

export const sidebarItemsQueryOptions = queryOptions({
  queryKey: ['sidebar', 'items'],
  queryFn: () => listSidebarItems(),
});

export const subappOpsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['subapps', id, 'ops'],
    queryFn: () => getSubappOps({ data: id }),
  });
