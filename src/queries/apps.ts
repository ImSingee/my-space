import { queryOptions } from '@tanstack/react-query';
import {
  getDashboard,
  getAppOps,
  getDeploymentBuildLog,
  listAvailableWidgets,
  listDashboards,
  listDeployments,
  listSidebarItems,
  listApps,
} from '~server/apps';

export const appsQueryOptions = queryOptions({
  queryKey: ['apps'],
  queryFn: () => listApps(),
});

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

export const deploymentsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'deployments'],
    queryFn: () => listDeployments({ data: id }),
  });

export const deploymentBuildLogQueryOptions = (
  appId: string,
  deploymentId: string,
) =>
  queryOptions({
    queryKey: ['apps', appId, 'deployments', deploymentId, 'build-log'],
    queryFn: () => getDeploymentBuildLog({ data: { id: appId, deploymentId } }),
    // A deployment's build log is immutable, so never refetch once loaded.
    staleTime: Number.POSITIVE_INFINITY,
  });

export const sidebarItemsQueryOptions = queryOptions({
  queryKey: ['sidebar', 'items'],
  queryFn: () => listSidebarItems(),
});

export const appOpsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'ops'],
    queryFn: () => getAppOps({ data: id }),
  });
