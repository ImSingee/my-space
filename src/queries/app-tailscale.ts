import { queryOptions } from '@tanstack/react-query';
import { getAppTailscaleStatus } from '~server/app-tailscale';
export const appTailscaleQueryOptions = (appId: string) =>
  queryOptions({
    queryKey: ['app-tailscale', appId],
    queryFn: () => getAppTailscaleStatus({ data: { appId } }),
    refetchInterval: 2000,
  });
