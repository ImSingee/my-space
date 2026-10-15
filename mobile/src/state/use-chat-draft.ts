import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetStateAction } from 'react';
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
  return {
    draft: data.text,
    files: data.files,
    setDraft: (text: string) => {
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
