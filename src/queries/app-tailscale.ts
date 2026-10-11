import { queryOptions } from '@tanstack/react-query';
import {
  getAppTailscaleStatus,
  listAppTailscaleStatuses,
} from '~server/app-tailscale';
export const appTailscaleQueryOptions = (appId: string) =>
  queryOptions({
    queryKey: ['app-tailscale', appId],
    queryFn: () => getAppTailscaleStatus({ data: { appId } }),
    refetchInterval: 2000,
  });

export const appTailscaleStatusesQueryOptions = queryOptions({
  queryKey: ['app-tailscale-statuses'],
  queryFn: () => listAppTailscaleStatuses(),
  refetchInterval: 2000,
});
