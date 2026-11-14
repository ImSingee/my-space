/**
 * Hatch deep links: `hatch://<web path>[?instance=<origin>][#<fragment>]`.
 *
 * A deep link names a Hatch page by the path the instance serves it at, so
 * replacing an instance origin with `hatch://` turns a Hatch web address into
 * a link to the same page. The phone app opens it natively; the web turns it
 * back into the instance address. The host is read as the first path segment
 * (`hatch://app/x` is `hatch:///app/x`). `instance` names which instance the
 * page is on; without it the link means the instance that shows it.
 *
 * Pure and dependency-free so the platform, its web UI and the phone app share
 * one grammar.
 */

export const DEEP_LINK_SCHEME = 'hatch';
export const MAX_DEEP_LINK_LENGTH = 4096;
export const MAX_DEEP_LINK_FRAGMENT = 2048;

/** Sign-in, device login and API endpoints are never pages a link opens. */
export const RESERVED_LINK_ROOTS: ReadonlySet<string> = new Set([
  'api',
  'cli',
  'login',
]);

export type HatchLink = {
  /** Canonical origin the link names, or null for the instance showing it. */
  instance: string | null;
  /** Decoded path segments; empty for the start page. */
  segments: string[];
  /** The query without `instance`, including its `?`, if any remains. */
  search?: string;
  /** The fragment without `#`: an App's own route, for example. */
  hash?: string;
};

export type InstanceOptions = {
  /** Accept `http://` loopback instances (development builds only). */
  allowLoopbackHttp?: boolean;
};

// URL controls, whitespace and backslashes are never part of a link.
// oxlint-disable-next-line no-control-regex
const forbidden = /[\u0000- \u007f\\]/;
// A decoded path segment: unreserved URL characters only.
const SEGMENT = /^[A-Za-z0-9._~-]{1,256}$/;
const HATCH_LINK = /^hatch:(?:\/\/)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Decodes ASCII percent-escapes, nested up to a few levels. Paths, slugs and
 * tickets use ASCII, so this reveals them however they are encoded, while an
 * unrelated malformed escape or invalid UTF-8 cannot hide them. Excessive
 * nesting is ambiguous and returns null.
 */
export function decodeUrlAscii(value: string): string | null {
  let text = value;
  for (let depth = 0; depth < 4; depth++) {
    const decoded = text.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === text) return text;
    text = decoded;
  }
  return /%[0-7][0-9a-f]/i.test(text) ? null : text;
}

export function isDeepLink(value: string): boolean {
  return /^hatch:/i.test(value);
}

/** The Expo development client opens its own `hatch://expo-development-client`. */
export function isDevClientLink(value: string): boolean {
  return /^hatch:\/\/expo-development-client(?:[/?#]|$)/i.test(value);
}

/**
 * An instance origin, or a bare host that means HTTPS. Only an origin: no
 * credentials, path, query or fragment.
 */
export function canonicalLinkInstance(
  value: string,
  options: InstanceOptions = {},
): string | null {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  if (
    forbidden.test(text) ||
    /[?#@]/.test(text) ||
    !/^https?:\/\/[^/]+\/?$/i.test(text)
  )
    return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const http =
    url.protocol === 'http:' &&
    options.allowLoopbackHttp === true &&
    LOOPBACK.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !http) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return null;
  return url.origin;
}

/**
 * Splits a raw path into decoded segments. Segments are split before decoding
 * so an encoded slash never becomes a separator, and dot segments are refused
 * rather than resolved.
 */
export function linkPathSegments(path: string): string[] | null {
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

/** A fragment without `#`; undefined when empty, null when too long. */
export function linkFragment(value: string | undefined) {
  const hash = value?.replace(/^#/, '') ?? '';
  if (hash.length > MAX_DEEP_LINK_FRAGMENT) return null;
  return hash || undefined;
}

/** Reads a `hatch:` link. Anything malformed or unsafe is null. */
export function parseHatchLink(
  value: string,
  options: InstanceOptions = {},
): HatchLink | null {
  if (value.length > MAX_DEEP_LINK_LENGTH || forbidden.test(value)) return null;
  if (isDevClientLink(value)) return null;
  const match = HATCH_LINK.exec(value);
  if (!match) return null;
  const [, path, query = '', fragment] = match;
  let instance: string | null = null;
  const rest: string[] = [];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const split = pair.indexOf('=');
    const key = split < 0 ? pair : pair.slice(0, split);
    if (key !== 'instance') {
      rest.push(pair);
      continue;
    }
    // A link naming two instances names neither.
    if (instance !== null) return null;
    let text: string;
    try {
      text = decodeURIComponent(split < 0 ? '' : pair.slice(split + 1));
    } catch {
      return null;
    }
    instance = canonicalLinkInstance(text, options);
    if (!instance) return null;
  }
  const segments = linkPathSegments(path);
  const hash = linkFragment(fragment);
  if (!segments || hash === null) return null;
  if (segments.length && RESERVED_LINK_ROOTS.has(segments[0])) return null;
  return {
    instance,
    segments,
    ...(rest.length ? { search: `?${rest.join('&')}` } : {}),
    ...(hash ? { hash } : {}),
  };
}

/** The web path a link names, with its query and fragment. */
export function hatchLinkPath(link: Omit<HatchLink, 'instance'>): string {
  return `/${link.segments.join('/')}${link.search ?? ''}${
    link.hash ? `#${link.hash}` : ''
  }`;
}

/**
 * The web address of the page a `hatch:` link names: on the instance it
 * names, else on `origin`. Null when the link is not one.
 */
export function hatchLinkWebUrl(
  value: string,
  origin: string,
  options: InstanceOptions = {},
): string | null {
  const link = parseHatchLink(value, options);
  if (!link) return null;
  return new URL(hatchLinkPath(link), link.instance ?? origin).href;
}

/** The `hatch:` link for a web path, optionally on a named instance. */
export function formatHatchLink(
  link: Omit<HatchLink, 'instance'>,
  instance?: string | null,
): string {
  const params = [
    ...(link.search ? link.search.slice(1).split('&') : []),
    ...(instance ? [`instance=${encodeURIComponent(instance)}`] : []),
  ];
  return `${DEEP_LINK_SCHEME}://${link.segments.join('/')}${
    params.length ? `?${params.join('&')}` : ''
  }${link.hash ? `#${link.hash}` : ''}`;
}
