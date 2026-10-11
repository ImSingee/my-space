import { queryOptions } from '@tanstack/react-query';
import { getAgentRunnerStatusFn } from '~server/agent-runner-status';
import { listProviders } from '~server/providers';
import {
  getSession,
  listSessions,
  type SessionDetail,
} from '~server/agent-sessions';

export const providersQueryOptions = queryOptions({
  queryKey: ['agent', 'providers'],
  queryFn: () => listProviders(),
});

export const agentRunnerStatusQueryOptions = queryOptions({
  queryKey: ['agent', 'runner-status'],
  queryFn: () => getAgentRunnerStatusFn(),
  // Runner connections live in platform memory and runs progress without any
  // client-side event to invalidate on, so poll while the page is open.
  // Paused when the tab is hidden (refetchIntervalInBackground defaults to
  // false).
  refetchInterval: 5000,
});

export const sessionsQueryOptions = queryOptions({
  queryKey: ['agent', 'sessions'],
  queryFn: () => listSessions({ data: {} }),
});

export type SessionSnapshot = SessionDetail & {
  /** Server clock minus browser clock, estimated when the snapshot arrived. */
  clockOffsetMs: number;
};

export function sessionQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: ['agent', 'session', sessionId],
    queryFn: async (): Promise<SessionSnapshot | null> => {
      const requestedAt = Date.now();
      const session = await getSession({ data: sessionId });
      if (!session) return null;
      // Server timestamps drive the live work timer; align them to this
      // browser's clock, assuming the server read happened mid-request.
      const midpoint = (requestedAt + Date.now()) / 2;
      return {
        ...session,
        clockOffsetMs: Date.parse(session.serverTime) - midpoint,
      };
    },
  });
}
