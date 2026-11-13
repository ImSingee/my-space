import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState, type SetStateAction } from 'react';
import type { AskAnswer } from '../core';
import { useSession } from './session';

export type Picked = {
  id: string;
  name: string;
  uri: string;
  mimeType: string;
  size: number;
  image?: string;
};
export type ModelChoice = { providerId: string; modelId: string };
/**
 * Everything typed or chosen for the next message. It belongs to the
 * conversation, not to one screen: a fold or unfold moves the conversation to
 * another screen, which must send the same text, files and model.
 * `writer` names the screen that last set the text.
 */
type ChatDraft = {
  text: string;
  files: Picked[];
  model?: ModelChoice | null;
  writer?: string;
};
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
    model: data.model ?? null,
    setModel: (model: ModelChoice | null) =>
      client.setQueryData<ChatDraft>(queryKey, (previous = emptyDraft) => ({
        ...previous,
        model,
      })),
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

type AskDraft = Record<string, AskAnswer>;

/**
 * Answers chosen or typed for one pending question, kept for the
 * conversation so a fold or unfold before sending does not clear them. The
 * card reads them once when it mounts and writes every change back.
 */
export function useAskDraft(id: string, askId: string) {
  const { origin } = useSession();
  const client = useQueryClient();
  const { data: saved = {} } = useQuery<AskDraft>({
    queryKey: [origin, 'ask-draft', id, askId],
    queryFn: skipToken,
    initialData: {},
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const save = useCallback(
    (answers: AskDraft) =>
      client.setQueryData<AskDraft>([origin, 'ask-draft', id, askId], answers),
    [client, origin, id, askId],
  );
  return { saved, save };
}
