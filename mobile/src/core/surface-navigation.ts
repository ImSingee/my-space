import { HANDOFF_CONSUME_PATH } from './security';

/** What an authenticated web surface does with a navigation request. */
export type SurfaceDecision =
  /** Let the WebView load it. */
  | { action: 'load' }
  /** Ignore it; the current page stays as it is. */
  | { action: 'block' }
  /** Open the native App page instead. */
  | { action: 'app'; slug: string }
  /** The browser session ended. */
  | { action: 'expired' }
  /**
   * Leave the app: only this URL goes to the system, which opens the browser
   * or the app that owns its scheme.
   */
  | { action: 'external'; url: string };

export type SurfaceContext = {
  origin: string;
  /** Path the surface shows; a trailing slash covers everything below it. */
  target: string;
  handoff: { ticket: string; completionUrl: string };
  /** The exact completion page loaded, so the session cookie is stored. */
  signedIn: boolean;
  /** The destination page finished loading. */
  ready: boolean;
  canOpenApp: boolean;
};

export type SurfaceRequest = {
  url: string;
  /** iOS only. Android reports top-level navigations without it. */
  isTopFrame?: boolean;
  /** 'click' for a followed link. iOS reports script navigation as 'other'. */
  navigationType?: string;
};

const LOAD = { action: 'load' } as const;
const BLOCK = { action: 'block' } as const;
// Consume, completion and any later handoff step.
const HANDOFF_PREFIX = '/api/auth/handoffs/';
const APP_PATH = /^\/app\/([A-Za-z0-9_-]+)(?:\/|$)/;

// Paths and tickets use ASCII. Decode those escapes independently so an
// unrelated malformed escape or invalid UTF-8 cannot hide a credential.
// Reject excessive nesting rather than passing an ambiguous URL outside.
function decodeUrlAscii(value: string): string | null {
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

function parse(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A URL on this instance that carries no credentials. */
function ownUrl(value: string, origin: string) {
  const url = parse(value);
  return url && url.origin === origin && !url.username && !url.password
    ? url
    : null;
}

function inTarget(url: URL, target: string) {
  return (
    url.pathname === target ||
    (target.endsWith('/') && url.pathname.startsWith(target))
  );
}

// Schemes a web view resolves inside its own document. They name no page and
// no other app, so there is nothing outside the app to hand them to.
const DOCUMENT_SCHEMES = new Set([
  'about:',
  'blob:',
  'data:',
  'file:',
  'javascript:',
]);

/**
 * The only thing that leaves the app is a URL for the system to open: a web
 * page in the browser, or a link in any other scheme (`mailto:`, `tel:`,
 * `someapp://…`) in the app that owns it. It never carries the handoff ticket;
 * a web URL also carries no credentials and is never a handoff page. Cookies
 * and tokens never go with it.
 */
export function externalUrl(
  value: string,
  context: Pick<SurfaceContext, 'origin' | 'handoff'>,
) {
  const url = parse(value);
  if (!url || DOCUMENT_SCHEMES.has(url.protocol)) return null;
  const web = url.protocol === 'https:' || url.protocol === 'http:';
  if (web && (url.username || url.password)) return null;
  const text = decodeUrlAscii(url.href);
  const path = decodeUrlAscii(url.pathname);
  if (text === null || path === null) return null;
  if (web && url.origin === context.origin) {
    // URL normalizes dot segments and backslashes after decoding as well.
    const normalized = parse(`${url.origin}${path}`)?.pathname;
    if (
      !normalized ||
      normalized === HANDOFF_PREFIX.slice(0, -1) ||
      normalized.startsWith(HANDOFF_PREFIX)
    )
      return null;
  }
  if (context.handoff.ticket && text.includes(context.handoff.ticket))
    return null;
  return url.href;
}

function leave(value: string, context: SurfaceContext): SurfaceDecision {
  if (!context.signedIn) return BLOCK;
  const url = externalUrl(value, context);
  return url ? { action: 'external', url } : BLOCK;
}

/** A load request inside the WebView (`onShouldStartLoadWithRequest`). */
export function decideLoad(
  request: SurfaceRequest,
  context: SurfaceContext,
): SurfaceDecision {
  const subframe = request.isTopFrame === false;
  if (request.url === 'about:blank')
    return subframe || !context.signedIn ? LOAD : BLOCK;
  // Dashboard widgets mount in sandboxed srcdoc subframes. An opaque document
  // never replaces the authenticated top-level surface.
  if (request.url === 'about:srcdoc') return subframe ? LOAD : BLOCK;
  const own = ownUrl(request.url, context.origin);
  if (subframe) {
    if (own) return LOAD;
    // A link followed inside an embedded frame leaves the app; frames that
    // load on their own stay blocked.
    return request.navigationType === 'click'
      ? leave(request.url, context)
      : BLOCK;
  }
  if (!context.signedIn)
    return own &&
      (own.pathname === HANDOFF_CONSUME_PATH ||
        own.href === context.handoff.completionUrl)
      ? LOAD
      : BLOCK;
  if (own) {
    if (inTarget(own, context.target)) return LOAD;
    const app = own.pathname.match(APP_PATH);
    if (app && context.canOpenApp) return { action: 'app', slug: app[1] };
    if (own.pathname === '/login') return { action: 'expired' };
    return BLOCK;
  }
  // Followed links leave the app. Script navigation counts only once the page
  // is showing, so a page cannot bounce the person out while it loads.
  const followed =
    request.navigationType === undefined ||
    request.navigationType === 'click' ||
    (request.navigationType === 'other' && context.ready);
  return followed ? leave(request.url, context) : BLOCK;
}

/**
 * A new window (`target="_blank"` or a user-initiated `window.open`) always
 * opens outside the app: web pages in the system browser, even this App's own
 * pages, and other schemes in the app that owns them. Nothing loads in the
 * view, so its history does not change.
 */
export function decideNewWindow(
  value: string,
  context: SurfaceContext,
): SurfaceDecision {
  return leave(value, context);
}

/**
 * Whether a native back action belongs to the page's own history: only a
 * single step back. Resets, multi-screen pops and other removals (sign-out,
 * dismissing a stack) always reach the native stack, so a page can never hold
 * the person in place.
 */
export function stepsBackInPage(action: { type: string; payload?: object }) {
  if (action.type === 'GO_BACK') return true;
  if (action.type !== 'POP') return false;
  const count =
    action.payload && 'count' in action.payload ? action.payload.count : 1;
  return count === 1;
}
