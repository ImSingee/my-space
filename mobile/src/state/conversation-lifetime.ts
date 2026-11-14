import { useCallback, useEffect, useRef } from 'react';

/**
 * How long a conversation's work waits for another screen to take it over.
 * Folding, unfolding or resizing moves a conversation between the Agent
 * list's pane and its own screen: the old screen unmounts a moment before the
 * new one mounts, and an upload or a run request in flight must survive that.
 */
const HANDOFF_MS = 2000;

type Lifetime = {
  controller: AbortController;
  owners: number;
  timer: ReturnType<typeof setTimeout> | null;
};
const lifetimes = new Map<string, Lifetime>();

/**
 * Ends every conversation's work at once. Called when the signed-in identity
 * changes, so no request started before can pick up a new credential.
 */
export function endConversationLifetimes() {
  for (const lifetime of lifetimes.values()) {
    if (lifetime.timer) clearTimeout(lifetime.timer);
    lifetime.controller.abort();
  }
  lifetimes.clear();
}

/**
 * An abort signal for one conversation's mutations, shared by every screen
 * showing it. It aborts when the last of them is removed and no other takes
 * over within the handoff window, or when the identity changes.
 */
export function useConversationLifetime(
  origin: string | null,
  id: string,
  /** Runs when no earlier screen's work for this conversation is still live. */
  onStart?: () => void,
) {
  const key = JSON.stringify([origin, id]);
  // Until the effect attaches, work belongs to a controller of this mount.
  const current = useRef<AbortController>(new AbortController());
  useEffect(() => {
    let lifetime = lifetimes.get(key);
    if (!lifetime) {
      lifetime = { controller: new AbortController(), owners: 0, timer: null };
      lifetimes.set(key, lifetime);
      onStart?.();
    }
    if (lifetime.timer) clearTimeout(lifetime.timer);
    lifetime.timer = null;
    lifetime.owners++;
    current.current = lifetime.controller;
    const owned = lifetime;
    return () => {
      owned.owners--;
      if (owned.owners > 0) return;
      owned.timer = setTimeout(() => {
        if (owned.owners > 0 || lifetimes.get(key) !== owned) return;
        lifetimes.delete(key);
        owned.controller.abort();
      }, HANDOFF_MS);
    };
  }, [key, onStart]);
  return useCallback(() => current.current.signal, []);
}
