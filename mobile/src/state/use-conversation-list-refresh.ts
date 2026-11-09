import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import type { SessionDetail } from '../core';
import {
  FOLLOW_MS,
  followKey,
  listRead,
  needsRead,
  nextListRead,
  observe,
  type FollowedConversation,
} from './conversation-follow';
import { useSession } from './session';

const none: FollowedConversation[] = [];

/**
 * Keeps the conversation list current after leaving a conversation mid-run.
 * Returning re-reads the list. Conversations this device asked to run are
 * followed while the list is on screen, even if they left before the run
 * reached the server, until the run ends and the list has been re-read a
 * few times for a transcript saved afterwards. Nothing else is polled.
 */
export function useConversationListRefresh(
  focused: boolean,
  refetchList: () => unknown,
) {
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  const returned = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (returned.current) void refetchList();
      returned.current = true;
    }, [refetchList]),
  );
  const followed =
    useQuery({
      queryKey: followKey(origin),
      queryFn: () => none,
      initialData: none,
      staleTime: Infinity,
      enabled: false,
    }).data ?? none;
  const reading = followed.filter(needsRead);
  const reads = useQueries({
    queries: reading.map((entry) => ({
      queryKey: [origin, 'session', entry.sessionId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api!.session(entry.sessionId, signal),
      enabled: Boolean(api) && focused,
      refetchInterval: FOLLOW_MS,
    })),
  });
  const observed = followed.map((entry) => {
    const read = reads[reading.indexOf(entry)];
    if (!read) return entry;
    if (read.errorUpdatedAt > read.dataUpdatedAt)
      return observe(entry, null, read.errorUpdatedAt);
    // A read from before the run was asked for says nothing about it.
    const data = read.data as SessionDetail | undefined;
    if (!data || read.dataUpdatedAt < entry.since) return entry;
    return observe(entry, Boolean(data.activeRun), read.dataUpdatedAt);
  });
  const changed = observed.some((entry, index) => entry !== followed[index]);
  useEffect(() => {
    if (!changed) return;
    queryClient.setQueryData<FollowedConversation[]>(
      followKey(origin),
      (list = none) =>
        list.map(
          (entry) =>
            observed.find(
              (next) =>
                next.sessionId === entry.sessionId &&
                next.since === entry.since,
            ) ?? entry,
        ),
    );
  }, [changed, observed, queryClient, origin]);
  useEffect(() => {
    if (!focused) return;
    const now = Date.now();
    const wait = Math.min(
      ...followed.map((entry) => nextListRead(entry, now) ?? Infinity),
    );
    if (wait === Infinity) return;
    const timer = setTimeout(() => {
      void refetchList();
      queryClient.setQueryData<FollowedConversation[]>(
        followKey(origin),
        (list = none) => listRead(list, Date.now()),
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [focused, followed, refetchList, queryClient, origin]);
}
