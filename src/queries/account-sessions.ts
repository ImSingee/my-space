import { queryOptions } from '@tanstack/react-query';
import {
  listAccountSessions,
  revokeAccountSession,
} from '~server/account-sessions';

export type AccountSession = Awaited<
  ReturnType<typeof listAccountSessions>
>['items'][number];

export const accountSessionsQueryOptions = queryOptions({
  queryKey: ['auth', 'account-sessions'],
  // Account-specific metadata must not survive leaving Account/signing out.
  gcTime: 0,
  retry: false,
  networkMode: 'always',
  queryFn: async ({ signal }) => (await listAccountSessions({ signal })).items,
});

// Server messages are not user-facing; every failure maps to retry guidance.
export async function signOutSession(sessionId: string) {
  try {
    await revokeAccountSession({ data: { sessionId } });
  } catch {
    throw new Error('Could not sign out that device. Please try again.');
  }
}
