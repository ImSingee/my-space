import {
  RESERVED_LINK_ROOTS,
  formatHatchLink,
  isDeepLink,
  linkFragment,
  linkPathSegments,
  parseHatchLink,
} from '@hatch/platform-api';
import type { TabId } from './navigation-preferences';
import type { InstanceUrlOptions } from './security';

export { isDeepLink, isDevClientLink } from '@hatch/platform-api';

/**
 * Deep links name Hatch pages by their web paths (the grammar lives in
 * `deep-link.ts` of `@hatch/platform-api`, shared with the platform). Replacing an
 * instance origin with `hatch://` turns any Hatch web address into a link that
 * opens the same page in this app:
 *
 *   hatch://app/sales#/reports              an App page, at its own route
 *   hatch://agent/<conversation id>
 *   hatch://workflow/nightly?instance=hatch.example.com
 *
 * `instance` names which signed-in instance the page belongs to; without it
 * the link opens on the instance in use. Pages that exist only on the phone
 * live under `/more`, which no web page uses. Instance pages the app has no
 * screen for open in the browser. A link only ever navigates.
 */
export type LinkTarget =
  /** The start page chosen in Tabs & start page. */
  | { kind: 'start' }
  | { kind: 'tab'; tab: TabId | 'more' }
  | { kind: 'dashboard'; id: string }
  /** `hash` is the App's own route, as after `#` in its web address. */
  | { kind: 'app'; slug: string; hash?: string }
  | { kind: 'conversation'; id: string }
  | { kind: 'workflow'; slug: string }
  | { kind: 'notifications' }
  | { kind: 'notification'; id: string }
  | { kind: 'phone'; page: PhonePage }
  /** An instance page this app has no screen for. */
  | { kind: 'web'; path: string; search?: string; hash?: string };

export type PhonePage = 'tabs' | 'instance' | 'notifications';
export type DeepLink = {
  /** Canonical origin the link names, or null for the instance in use. */
  instance: string | null;
  target: LinkTarget;
};

// The same rules the App and resource screens apply to what they load.
const SLUG = /^[A-Za-z0-9_-]{1,191}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
// Addresses are read with the same length bound as links.
const MAX_ADDRESS_LENGTH = 4096;
const PHONE_PAGES = new Set<string>(['tabs', 'instance', 'notifications']);

/** The page a web path names, or null when it names none that may open. */
export function platformTarget(
  segments: string[],
  hash?: string,
  search?: string,
): LinkTarget | null {
  const [first, second, third] = segments;
  const count = segments.length;
  const web = (): LinkTarget => ({
    kind: 'web',
    path: `/${segments.join('/')}`,
    ...(search ? { search } : {}),
    ...(hash ? { hash } : {}),
  });
  if (!count) return { kind: 'start' };
  if (RESERVED_LINK_ROOTS.has(first)) return null;
  switch (first) {
    case 'dashboard':
    case 'dashboards':
      if (count === 1) return { kind: 'tab', tab: 'dashboard' };
      if (first === 'dashboard' && count === 2)
        return ID.test(second) ? { kind: 'dashboard', id: second } : null;
      return web();
    case 'mobile':
      // The phone's own dashboard canvas.
      if (second === 'dashboard' && count === 3)
        return ID.test(third) ? { kind: 'dashboard', id: third } : null;
      return null;
    case 'apps':
      return count === 1 ? { kind: 'tab', tab: 'apps' } : web();
    case 'app':
      if (count === 1) return { kind: 'tab', tab: 'apps' };
      if (!SLUG.test(second)) return null;
      // The web page and the App's own embed address are the same App.
      if (count === 2 || (count === 3 && third === 'embed'))
        return { kind: 'app', slug: second, ...(hash ? { hash } : {}) };
      return web();
    case 'agent':
      if (count === 1) return { kind: 'tab', tab: 'agent' };
      if (count === 2)
        return ID.test(second) ? { kind: 'conversation', id: second } : null;
      return web();
    case 'workflows':
      return count === 1 ? { kind: 'tab', tab: 'workflows' } : web();
    case 'workflow':
      if (count === 1) return { kind: 'tab', tab: 'workflows' };
      if (!SLUG.test(second)) return null;
      return count === 2 ? { kind: 'workflow', slug: second } : web();
    case 'notifications':
      if (count === 1) return { kind: 'notifications' };
      if (count === 2)
        return ID.test(second) ? { kind: 'notification', id: second } : null;
      return web();
    case 'more':
      if (count === 1) return { kind: 'tab', tab: 'more' };
      return count === 2 && PHONE_PAGES.has(second)
        ? { kind: 'phone', page: second as PhonePage }
        : null;
    default:
      return web();
  }
}

/** Reads a `hatch:` link. Anything malformed or unsafe is null. */
export function parseDeepLink(
  value: string,
  options: InstanceUrlOptions = {},
): DeepLink | null {
  const link = parseHatchLink(value, {
    allowLoopbackHttp: options.allowDevelopmentLoopback,
  });
  if (!link) return null;
  const target = platformTarget(link.segments, link.hash, link.search);
  return target ? { instance: link.instance, target } : null;
}

/** Reads an address on `origin` itself, as a link to the same page. */
export function instanceLink(value: string, origin: string): DeepLink | null {
  if (value.length > MAX_ADDRESS_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  const segments = linkPathSegments(url.pathname);
  const hash = linkFragment(url.hash);
  if (!segments || hash === null) return null;
  const target = platformTarget(segments, hash, url.search || undefined);
  return target ? { instance: origin, target } : null;
}

/** A `hatch:` link, or an address on the instance in use. */
export function resolveLink(
  value: string,
  origin: string | null,
  options: InstanceUrlOptions = {},
): DeepLink | null {
  if (isDeepLink(value)) return parseDeepLink(value, options);
  return origin ? instanceLink(value, origin) : null;
}

/** How the phone opens the URL a notification carries. */
export type NotificationUrlAction =
  /** A Hatch page: opened in the app, on `link.instance`. */
  | { open: 'page'; link: DeepLink & { instance: string } }
  /** Any other page or scheme, through the system. */
  | { open: 'outside'; url: string }
  /** A `hatch:` link this app cannot read. */
  | { open: 'none' };

/**
 * A notification URL from `origin`: its own address or a `hatch:` link opens
 * the page in the app (on `origin` unless the link names an instance), and a
 * `hatch:` link never leaves for the system, not even for a page the app has
 * no screen for (that page opens in the in-app browser on its instance).
 */
export function notificationUrlAction(
  url: string,
  origin: string,
  options: InstanceUrlOptions = {},
): NotificationUrlAction {
  const deep = isDeepLink(url);
  const link = deep ? parseDeepLink(url, options) : instanceLink(url, origin);
  if (link && (deep || link.target.kind !== 'web'))
    return {
      open: 'page',
      link: { instance: link.instance ?? origin, target: link.target },
    };
  return deep ? { open: 'none' } : { open: 'outside', url };
}

function segmentsOf(target: LinkTarget): string[] {
  switch (target.kind) {
    case 'start':
      return [];
    case 'tab':
      return [target.tab];
    case 'dashboard':
      return ['dashboard', target.id];
    case 'app':
      return ['app', target.slug];
    case 'conversation':
      return ['agent', target.id];
    case 'workflow':
      return ['workflow', target.slug];
    case 'notifications':
      return ['notifications'];
    case 'notification':
      return ['notifications', target.id];
    case 'phone':
      return ['more', target.page];
    case 'web':
      return target.path.split('/').filter(Boolean);
  }
}

/** The `hatch:` link for a page, optionally on a named instance. */
export function deepLinkFor(target: LinkTarget, instance?: string | null) {
  return formatHatchLink(
    {
      segments: segmentsOf(target),
      ...(target.kind === 'web' && target.search
        ? { search: target.search }
        : {}),
      ...((target.kind === 'app' || target.kind === 'web') && target.hash
        ? { hash: target.hash }
        : {}),
    },
    instance,
  );
}

/** What to do with a link, given the instance in use. */
export type DeliveryPlan =
  | { step: 'open' }
  /** Nothing is signed in yet: open it once something is. */
  | { step: 'hold' }
  /** Switch to the named, signed-in instance first. */
  | { step: 'switch'; instance: string; confirm: boolean }
  /** The named instance is not signed in on this phone. */
  | { step: 'unavailable'; instance: string };

/**
 * A link never signs in or adds an instance. It may switch to another
 * instance this phone is already signed in to; a link from outside asks
 * first, while a decrypted push from that instance is its own proof.
 */
export function deliveryPlan(
  link: DeepLink,
  trusted: boolean,
  session: { origin: string | null; instanceSignedIn: boolean },
): DeliveryPlan {
  if (!link.instance)
    return session.origin ? { step: 'open' } : { step: 'hold' };
  if (link.instance === session.origin) return { step: 'open' };
  if (!session.instanceSignedIn)
    return { step: 'unavailable', instance: link.instance };
  return { step: 'switch', instance: link.instance, confirm: !trusted };
}
