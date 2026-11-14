import type { DeepLink } from '../core/deep-link';

/** A link waiting to open, with what it may do on the way. */
export type LinkEntry = {
  link: DeepLink;
  /**
   * A decrypted push from the instance it names. Only it switches instances
   * without asking; a link from anywhere else asks first.
   */
  trusted: boolean;
  /**
   * 'system' came from outside the app and opens on a clean root stack;
   * 'surface' came from a page on screen and opens on top of it, so back
   * returns there.
   */
  from: 'system' | 'surface';
};

// One slot: a newer link replaces one that has not opened yet.
let pending: LinkEntry | null = null;
const listeners = new Set<() => void>();

export const linkInbox = {
  put(entry: LinkEntry) {
    pending = entry;
    for (const listener of listeners) listener();
  },
  peek: () => pending,
  /** Clears the slot only when it still holds this entry. */
  done(entry: LinkEntry) {
    if (pending === entry) pending = null;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
