import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SetStateAction } from 'react';
import { useSession } from './session';

export type Picked = {
  id: string;
  name: string;
  uri: string;
  mimeType: string;
  size: number;
  image?: string;
};
type ChatDraft = { text: string; files: Picked[] };
const emptyDraft: ChatDraft = { text: '', files: [] };

export function useChatDraft(id: string) {
  const { origin } = useSession();
  const client = useQueryClient();
  const queryKey = [origin, 'draft', id];
  const { data = emptyDraft } = useQuery<ChatDraft>({
    queryKey,
    queryFn: skipToken,
    initialData: emptyDraft,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const scope = JSON.stringify([origin, id]);
  // Query notifications are batched. Feeding them back into a native controlled
  // input can overwrite newer keystrokes and move the selection backwards.
  const [input, setInput] = useState({ scope, text: data.text });
  if (input.scope !== scope) setInput({ scope, text: data.text });
  return {
    draft: input.scope === scope ? input.text : data.text,
    files: data.files,
    setDraft: (text: string) => {
      setInput({ scope, text });
      client.setQueryData<ChatDraft>(queryKey, (previous = emptyDraft) => ({
        ...previous,
        text,
      }));
    },
    setFiles: (files: SetStateAction<Picked[]>) => {
      client.setQueryData<ChatDraft>(queryKey, (previous = emptyDraft) => ({
        ...previous,
        files: typeof files === 'function' ? files(previous.files) : files,
      }));
    },
  };
}
