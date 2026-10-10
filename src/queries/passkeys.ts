import { queryOptions } from '@tanstack/react-query';
import { getPasskeyOrigin } from '~server/passkeys';

export const passkeyOriginQueryOptions = queryOptions({
  queryKey: ['auth', 'passkey-origin'],
  queryFn: () => getPasskeyOrigin(),
});
