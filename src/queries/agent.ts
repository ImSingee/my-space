import { queryOptions } from '@tanstack/react-query';
import { getAgentRunnerStatusFn } from '~server/agent-runner-status';
import { listProviders } from '~server/providers';
import { getSession, listSessions } from '~server/agent-sessions';

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
  queryFn: () => listSessions(),
});

export function sessionQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: ['agent', 'session', sessionId],
    queryFn: () => getSession({ data: sessionId }),
  });
}
