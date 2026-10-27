import type { SessionHandoff } from './types';

export const HANDOFF_CONSUME_PATH = '/api/auth/handoffs/consume';
export const HANDOFF_COMPLETION_PATH = '/api/auth/handoffs/complete';

export type InstanceUrlOptions = { allowDevelopmentLoopback?: boolean };

export class MobileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MobileError';
  }
}

// Reject URL controls before the URL parser can silently remove them.
// oxlint-disable-next-line no-control-regex
const forbidden = /[\u0000-\u0020\u007f\\]/;

/** A server address is an origin, never a request path or an authenticated URL. */
export function canonicalizeInstanceUrl(
  input: string,
  options: InstanceUrlOptions = {},
): string {
  try {
    if (!input || forbidden.test(input) || /[?#@]/.test(input))
      throw new Error();
    // Validate the original authority/path before URL can normalize dot segments.
    if (!/^https?:\/\/[^/]+\/?$/i.test(input)) throw new Error();
    const url = new URL(input);
    const devHttp =
      options.allowDevelopmentLoopback === true &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !devHttp)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new MobileError(
      'invalid_instance',
      'Enter an HTTPS instance origin without a path, query, or credentials.',
    );
  }
}

/** Validate the browser-only grant URL without ever attaching an API token. */
export function validateVerificationUrl(
  origin: string,
  input: string,
  userCode: string,
): string {
  try {
    if (forbidden.test(input)) throw new Error();
    const url = new URL(input);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== '/cli/authorize' ||
      url.searchParams.get('user_code') !== userCode ||
      [...url.searchParams.keys()].some((key) => key !== 'user_code') ||
      url.searchParams.getAll('user_code').length !== 1
    )
      throw new Error();
    return url.href;
  } catch {
    throw new MobileError(
      'invalid_verification_url',
      'The login page does not match this instance.',
    );
  }
}

export function apiPath(origin: string, path: string): string {
  if (
    !path.startsWith('/api/') ||
    forbidden.test(path) ||
    path.includes('#') ||
    /%(?:2f|5c|2e|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path) ||
    path
      .split('?')[0]
      .split('/')
      .some((part) => part === '.' || part === '..')
  ) {
    throw new MobileError('invalid_path', 'Invalid API path.');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new MobileError(
      'invalid_path',
      'API requests must stay on this instance.',
    );
  }
  return url.href;
}

export function pathId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
    throw new MobileError('invalid_id', 'Invalid resource identifier.');
  }
  return id;
}

export function validateToken(value: string): string {
  if (!value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) {
    throw new MobileError(
      'invalid_token',
      'The instance returned an invalid access token.',
    );
  }
  return value;
}

function isFixedInstanceUrl(origin: string, value: string, path: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    !forbidden.test(value) &&
    url.origin === origin &&
    url.pathname === path &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

/** Both handoff URLs are fixed instance endpoints; neither may name a resource. */
export function validateHandoff(origin: string, handoff: SessionHandoff): void {
  if (
    !isFixedInstanceUrl(origin, handoff.url, HANDOFF_CONSUME_PATH) ||
    !isFixedInstanceUrl(
      origin,
      handoff.completionUrl,
      HANDOFF_COMPLETION_PATH,
    ) ||
    !/^[A-Za-z0-9_-]{20,512}$/.test(handoff.ticket) ||
    !Number.isFinite(Date.parse(handoff.expiresAt)) ||
    Date.parse(handoff.expiresAt) <= Date.now()
  ) {
    throw new MobileError(
      'invalid_handoff',
      'The sign-in handoff is invalid or expired.',
    );
  }
}

/** The authenticated page a WebView opens after the handoff completes. */
export type BrowserDestination = { path: string; hash?: string };

export function appDestination(
  slug: string,
  hash?: string,
): BrowserDestination {
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(slug))
    throw new MobileError('invalid_id', 'Invalid App address.');
  return {
    path: `/app/${slug}/embed/`,
    hash: hash?.replace(/^#/, '') || undefined,
  };
}

export function dashboardDestination(id: string): BrowserDestination {
  if (!id || id.length > 191 || forbidden.test(id))
    throw new MobileError('invalid_id', 'Invalid Dashboard identifier.');
  return { path: `/mobile/dashboard/${encodeURIComponent(id)}` };
}

export function destinationUrl(
  origin: string,
  destination: BrowserDestination,
): string {
  const url = new URL(destination.path, origin);
  if (url.origin !== origin || url.pathname !== destination.path)
    throw new MobileError('invalid_path', 'Invalid page address.');
  if (destination.hash) url.hash = destination.hash;
  return url.href;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MobileError('cancelled', 'Cancelled.');
}

export function webViewHandoffSource(origin: string, handoff: SessionHandoff) {
  return {
    uri: handoff.url,
    method: 'POST' as const,
    body: `ticket=${encodeURIComponent(handoff.ticket)}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
  };
}

export function boundedSignal(parent?: AbortSignal, timeoutMs?: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
