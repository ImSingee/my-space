import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
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
