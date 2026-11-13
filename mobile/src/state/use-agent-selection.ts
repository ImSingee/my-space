import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useSession } from './session';

/**
 * The conversation list and an open conversation share a screen once both
 * fit (see `useFoldSplit`); below that the conversation is pushed over the
 * list. Both screens measure with these values, so they agree on which
 * layout applies.
 */
export const conversationSplit = { minColumn: 320, gap: 16 } as const;

/** Route parameter of a conversation pushed from the conversation list. */
export const fromConversationList = 'agent';

/**
 * The conversation open beside the list. It outlives the list's layout, so
 * folding, unfolding or resizing keeps the same conversation open. It lives
 * in memory with the instance's other queries and is cleared with them.
 */
export function useAgentSelection() {
  const { origin } = useSession();
  const client = useQueryClient();
  const { data = null } = useQuery<string | null>({
    queryKey: [origin, 'agent-selection'],
    queryFn: skipToken,
    initialData: null,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const select = useCallback(
    (id: string | null) =>
      client.setQueryData<string | null>([origin, 'agent-selection'], id),
    [client, origin],
  );
  return [data, select] as const;
}

const shownKey = (origin: string | null) => [origin, 'conversation-screens'];

/**
 * Conversations a pushed conversation screen is showing. One conversation
 * has one composer: while its own screen shows it, the list's pane does not
 * mount it as well (the two layouts switch at slightly different widths, so
 * a covered list can already have room for its pane).
 */
export function useConversationScreens() {
  const { origin } = useSession();
  const { data = [] } = useQuery<string[]>({
    queryKey: shownKey(origin),
    queryFn: skipToken,
    initialData: [],
    gcTime: Infinity,
    staleTime: Infinity,
  });
  return data;
}

/** Registers a mounted conversation screen for `useConversationScreens`. */
export function useShowsConversation(id: string) {
  const { origin } = useSession();
  const client = useQueryClient();
  useEffect(() => {
    const key = shownKey(origin);
    client.setQueryData<string[]>(key, (ids = []) => [...ids, id]);
    return () => {
      client.setQueryData<string[]>(key, (ids = []) => {
        // One screen leaves; another screen of the same conversation stays.
        const index = ids.indexOf(id);
        return ids.filter((_, at) => at !== index);
      });
    };
  }, [client, origin, id]);
}
