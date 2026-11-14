import type { TabId } from './navigation-preferences';
import { canonicalizeInstanceUrl, type InstanceUrlOptions } from './security';
import { decodeUrlAscii } from './url-text';

/**
 * Deep links name Hatch pages by their web paths. Replacing an instance
 * origin with `hatch://` turns any Hatch web address into a link that opens
 * the same page in this app:
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
  | { kind: 'web'; path: string; hash?: string };

export type PhonePage = 'tabs' | 'instance' | 'notifications';
export type DeepLink = {
  /** Canonical origin the link names, or null for the instance in use. */
  instance: string | null;
  target: LinkTarget;
};

export const DEEP_LINK_SCHEME = 'hatch';
const MAX_LINK_LENGTH = 4096;
const MAX_FRAGMENT_LENGTH = 2048;
// The same rules the App and resource screens apply to what they load.
const SLUG = /^[A-Za-z0-9_-]{1,191}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
// A decoded path segment: unreserved URL characters only.
const SEGMENT = /^[A-Za-z0-9._~-]{1,256}$/;
// Reject URL controls, whitespace and backslashes anywhere in a link.
// oxlint-disable-next-line no-control-regex
const forbidden = /[\u0000- \u007f\\]/;
// Sign-in, device login and API endpoints are never pages to open.
const RESERVED = new Set(['api', 'cli', 'login']);
const PHONE_PAGES = new Set<string>(['tabs', 'instance', 'notifications']);
const HATCH_LINK = /^hatch:(?:\/\/)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;

/** The development client opens its own `hatch://expo-development-client` links. */
export function isDevClientLink(value: string) {
  return /^hatch:\/\/expo-development-client(?:[/?#]|$)/i.test(value);
}

export function isDeepLink(value: string) {
  return /^hatch:/i.test(value);
}

/**
 * Splits a raw path into decoded segments. Segments are split before decoding
 * so an encoded slash never becomes a separator, and dot segments are refused
 * rather than resolved.
 */
function segmentsOf(path: string): string[] | null {
  const trimmed = path.replace(/^\/+/, '').replace(/\/$/, '');
  if (!trimmed) return [];
  const segments: string[] = [];
  for (const raw of trimmed.split('/')) {
    const segment = decodeUrlAscii(raw);
    if (
      segment === null ||
      !SEGMENT.test(segment) ||
      segment === '.' ||
      segment === '..'
    )
      return null;
    segments.push(segment);
  }
  return segments;
}

function fragmentOf(value: string | undefined) {
  const hash = value?.replace(/^#/, '') ?? '';
  if (hash.length > MAX_FRAGMENT_LENGTH) return null;
  return hash || undefined;
}

/** The page a web path names, or null when it names none that may open. */
export function platformTarget(
  segments: string[],
  hash?: string,
): LinkTarget | null {
  const [first, second, third] = segments;
  const count = segments.length;
  const web = (): LinkTarget => ({
    kind: 'web',
    path: `/${segments.join('/')}`,
    ...(hash ? { hash } : {}),
  });
  if (!count) return { kind: 'start' };
  if (RESERVED.has(first)) return null;
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

/** An instance origin, or a bare host that means HTTPS. */
function instanceOf(value: string, options: InstanceUrlOptions) {
  try {
    return canonicalizeInstanceUrl(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
      options,
    );
  } catch {
    return null;
  }
}

/** Reads a `hatch:` link. Anything malformed or unsafe is null. */
export function parseDeepLink(
  value: string,
  options: InstanceUrlOptions = {},
): DeepLink | null {
  if (value.length > MAX_LINK_LENGTH || forbidden.test(value)) return null;
  if (isDevClientLink(value)) return null;
  const match = HATCH_LINK.exec(value);
  if (!match) return null;
  const [, path, query = '', fragment] = match;
  let instance: string | null = null;
  for (const pair of query.split('&')) {
    const split = pair.indexOf('=');
    const key = split < 0 ? pair : pair.slice(0, split);
    if (key !== 'instance') continue;
    // A link naming two instances names neither.
    if (instance !== null) return null;
    let text: string;
    try {
      text = decodeURIComponent(split < 0 ? '' : pair.slice(split + 1));
    } catch {
      return null;
    }
    instance = instanceOf(text, options);
    if (!instance) return null;
  }
  const segments = segmentsOf(path);
  const hash = fragmentOf(fragment);
  if (!segments || hash === null) return null;
  const target = platformTarget(segments, hash);
  return target ? { instance, target } : null;
}

/** Reads an address on `origin` itself, as a link to the same page. */
export function instanceLink(value: string, origin: string): DeepLink | null {
  if (value.length > MAX_LINK_LENGTH || forbidden.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  const segments = segmentsOf(url.pathname);
  const hash = fragmentOf(url.hash);
  if (!segments || hash === null) return null;
  const target = platformTarget(segments, hash);
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

function pathOf(target: LinkTarget): string {
  switch (target.kind) {
    case 'start':
      return '';
    case 'tab':
      return target.tab;
    case 'dashboard':
      return `dashboard/${target.id}`;
    case 'app':
      return `app/${target.slug}`;
    case 'conversation':
      return `agent/${target.id}`;
    case 'workflow':
      return `workflow/${target.slug}`;
    case 'notifications':
      return 'notifications';
    case 'notification':
      return `notifications/${target.id}`;
    case 'phone':
      return `more/${target.page}`;
    case 'web':
      return target.path.replace(/^\//, '');
  }
}

/** The `hatch:` link for a page, optionally on a named instance. */
export function deepLinkFor(target: LinkTarget, instance?: string | null) {
  const hash =
    (target.kind === 'app' || target.kind === 'web') && target.hash
      ? `#${target.hash}`
      : '';
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  return `${DEEP_LINK_SCHEME}://${pathOf(target)}${query}${hash}`;
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
