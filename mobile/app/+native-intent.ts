import {
  isDeepLink,
  isDevClientLink,
  parseDeepLink,
} from '../src/core/deep-link';
import { linkInbox } from '../src/state/link-inbox';

/**
 * Every `hatch:` link the system hands the app, at launch or while it runs.
 * Expo Router never routes these itself: the link waits in the inbox until the
 * saved sign-in is restored and the stack can take it (`useDeepLinkLifecycle`).
 * Returning null keeps the current screen, or the start page at launch.
 */
export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string | null {
  if (!isDeepLink(path) || isDevClientLink(path)) return path;
  const link = parseDeepLink(path, { allowDevelopmentLoopback: __DEV__ });
  if (link) linkInbox.put({ link, trusted: false, from: 'system' });
  return null;
}
