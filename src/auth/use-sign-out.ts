import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { authClient } from './client';

const SIGN_OUT_KEY = ['auth', 'sign-out'];

/** All platform exit controls share request state and discard private caches. */
export function useSignOut() {
  const queryClient = useQueryClient();
  const pending = useIsMutating({ mutationKey: SIGN_OUT_KEY });
  const mutation = useMutation({
    mutationKey: SIGN_OUT_KEY,
    networkMode: 'always',
    retry: false,
    // Failures are toasted by the router's global mutation handler.
    mutationFn: async () => {
      const result = await authClient.signOut().catch(() => null);
      if (!result || result.error) {
        throw new Error('Could not sign out. Please try again.');
      }
    },
    // A fresh document discards the query, mutation and Better Auth stores.
    onSuccess: () => window.location.replace('/login'),
  });

  return {
    leaving: pending > 0 || mutation.isSuccess,
    signOut: () => {
      // Check the cache synchronously as well as disabling both entry points.
      if (
        !mutation.isSuccess &&
        queryClient.isMutating({ mutationKey: SIGN_OUT_KEY }) === 0
      ) {
        mutation.mutate();
      }
    },
  };
}
