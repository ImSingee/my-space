import type { ChatDraft } from './chat';

/**
 * In-memory hand-off for the first message typed in the new-chat hero. The hero
 * creates a session, then navigates to `/agent/$threadId`; the chat there picks
 * up the draft and streams the first reply. Kept out of the URL so image data
 * never bloats history or search params. A hard reload drops the draft, which is
 * fine — there is nothing to resume before the message has been sent.
 */
const drafts = new Map<string, ChatDraft>();

export function stashDraft(threadId: string, draft: ChatDraft): void {
  drafts.set(threadId, draft);
}

/** Read and remove the pending draft for a thread, so it is sent only once. */
export function takeDraft(threadId: string): ChatDraft | undefined {
  const draft = drafts.get(threadId);
  drafts.delete(threadId);
  return draft;
}
