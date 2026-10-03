import { queryOptions } from '@tanstack/react-query';
import { getTailscaleStatus } from '~server/tailscale';

export const tailscaleQueryOptions = queryOptions({
  queryKey: ['settings', 'tailscale'],
  queryFn: () => getTailscaleStatus(),
  refetchInterval: 2000,
  refetchIntervalInBackground: true,
});
