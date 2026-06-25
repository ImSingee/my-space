import { queryOptions } from '@tanstack/react-query';
import { listProviders } from '~server/providers';
import { getSession, listSessions } from '~server/agent-sessions';

export const providersQueryOptions = queryOptions({
  queryKey: ['agent', 'providers'],
  queryFn: () => listProviders(),
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
