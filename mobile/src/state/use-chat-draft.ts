import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SetStateAction } from 'react';
import { useSession } from './session';

export type Picked = {
  id: string;
  name: string;
  uri: string;
  mimeType: string;
  size: number;
  image?: string;
};
/** `writer` names the screen that last set the text. */
type ChatDraft = { text: string; files: Picked[]; writer?: string };
const emptyDraft: ChatDraft = { text: '', files: [] };

export function useChatDraft(id: string) {
  const { origin } = useSession();
  const client = useQueryClient();
  const writer = useId();
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
  // input can overwrite newer keystrokes and move the selection backwards, so
  // this screen's own edits never come back from the cache. Text another screen
  // of the same conversation set (a send it finished, after a fold handed the
  // conversation over) is taken once.
  const [input, setInput] = useState({ scope, text: data.text, seen: data });
  if (input.scope !== scope) setInput({ scope, text: data.text, seen: data });
  else if (
    input.seen !== data &&
    data.writer !== undefined &&
    data.writer !== writer
  )
    setInput({ scope, text: data.text, seen: data });
  return {
    draft: input.scope === scope ? input.text : data.text,
    files: data.files,
    setDraft: (text: string) => {
      setInput((previous) => ({ ...previous, scope, text }));
      client.setQueryData<ChatDraft>(queryKey, (previous = emptyDraft) => ({
        ...previous,
        text,
        writer,
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
