import { queryOptions } from '@tanstack/react-query';
import {
  getDashboard,
  getAppOps,
  getDeploymentBuildLog,
  getNormalizedManifest,
  listAppKvFn,
  listAvailableWidgets,
  listCronRunsFn,
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

export const cronRunsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'cron-runs'],
    queryFn: () => listCronRunsFn({ data: id }),
    // Scheduled fires are written by the background scheduler with no client
    // event to invalidate against, so poll while the panel is open to surface
    // them live. React Query pauses this when the tab is hidden
    // (refetchIntervalInBackground defaults to false), so it stays cheap;
    // manual "Run now" still invalidates for an instant update.
    refetchInterval: 15_000,
  });

export const normalizedManifestQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'manifest'],
    queryFn: () => getNormalizedManifest({ data: id }),
  });

export const appKvQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'kv'],
    queryFn: () => listAppKvFn({ data: id }),
  });
