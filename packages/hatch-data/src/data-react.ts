// @ts-self-types="./data-react.d.ts"
/** React Query adapter for @hatch/data. */
import { useEffect, useMemo } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  DataClient,
  DataQueryFor,
  DataQueryResultFor,
  DataSchema,
  DataTableName,
} from './data.js';

function isPermanentWatchError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    ![408, 425, 429].includes(status)
  );
}

/** Keep one React Query cache entry synchronized with the durable watcher. */
export function subscribeDataQueryCache<
  TSchema extends DataSchema,
  TName extends DataTableName<TSchema>,
>(
  client: DataClient<TSchema>,
  query: DataQueryFor<TSchema, TName>,
  queryClient: Pick<QueryClient, 'fetchQuery' | 'setQueryData'>,
  queryKey: QueryKey,
): () => void {
  return client.watch(
    query,
    (snapshot) => queryClient.setQueryData(queryKey, snapshot),
    (error) => {
      if (!isPermanentWatchError(error)) return;
      // Drive the existing Query into its normal error state so consumers
      // cannot remain successfully stale after watch() stops on a 4xx.
      void queryClient
        .fetchQuery({
          queryKey,
          queryFn: () => Promise.reject(error),
          retry: false,
          staleTime: 0,
        })
        .catch(() => {});
    },
  );
}

export function useDataQuery<
  TSchema extends DataSchema,
  TName extends DataTableName<TSchema>,
>(
  client: DataClient<TSchema>,
  query: DataQueryFor<TSchema, TName>,
): UseQueryResult<DataQueryResultFor<TSchema, TName>, Error> {
  const queryClient = useQueryClient();
  const stable = JSON.stringify(query);
  const stableQuery = useMemo(
    () => JSON.parse(stable) as DataQueryFor<TSchema, TName>,
    [stable],
  );
  const queryKey = useMemo(
    () => ['hatch-data', client.cacheNamespace, stable] as const,
    [client.cacheNamespace, stable],
  );
  const result = useQuery({
    queryKey,
    queryFn: () => client.query(stableQuery),
    // watch() owns the initial snapshot as well as subsequent refreshes. A
    // second automatic query here would duplicate the initial request.
    enabled: false,
  });

  useEffect(
    () => subscribeDataQueryCache(client, stableQuery, queryClient, queryKey),
    [client, queryClient, queryKey, stableQuery],
  );

  return result;
}
