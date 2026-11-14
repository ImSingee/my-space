import {
  instanceLink,
  isDeepLink,
  parseDeepLink,
  type DeepLink,
} from './deep-link';
import { HANDOFF_CONSUME_PATH } from './security';
import { decodeUrlAscii } from './url-text';

/** What an authenticated web surface does with a navigation request. */
export type SurfaceDecision =
  /** Let the WebView load it. */
  | { action: 'load' }
  /** Ignore it; the current page stays as it is. */
  | { action: 'block' }
  /** Open this page natively instead (see `deep-link.ts`). */
  | { action: 'route'; link: DeepLink }
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
  /** The screen opens Hatch pages natively when links lead to them. */
  canRoute: boolean;
  /** Development builds accept `http://` loopback instances in links. */
  allowDevelopmentLoopback?: boolean;
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
  // Hatch's own links open here, never through the system and back.
  if (isDeepLink(value)) {
    const link = context.canRoute
      ? parseDeepLink(value, {
          allowDevelopmentLoopback: context.allowDevelopmentLoopback,
        })
      : null;
    return link ? { action: 'route', link } : BLOCK;
  }
  const url = externalUrl(value, context);
  return url ? { action: 'external', url } : BLOCK;
}

/**
 * A page on this instance outside the surface opens natively when the app has
 * a screen for it. Pages it has none for stay where they are: they would need
 * a browser session the system browser does not have.
 */
export function surfaceRoute(
  value: string,
  context: Pick<SurfaceContext, 'origin' | 'canRoute'>,
): SurfaceDecision {
  const link = context.canRoute ? instanceLink(value, context.origin) : null;
  return link && link.target.kind !== 'web' ? { action: 'route', link } : BLOCK;
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
  // Followed links leave the surface. Script navigation counts only once the
  // page is showing, so a page cannot bounce the person away while it loads.
  const followed =
    request.navigationType === undefined ||
    request.navigationType === 'click' ||
    (request.navigationType === 'other' && context.ready);
  if (own) {
    if (inTarget(own, context.target)) return LOAD;
    if (own.pathname === '/login') return { action: 'expired' };
    return followed ? surfaceRoute(own.href, context) : BLOCK;
  }
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
