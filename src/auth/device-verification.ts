/**
 * Device login started on the bound Tailscale origin must be approved on that
 * same origin: the CLI refuses a verification URL on any other origin, and the
 * browser session for the tailnet host lives under that host's cookies.
 */

/**
 * Return the trusted Tailscale origin when the request's Host names it.
 *
 * Only the currently trusted origin can be returned, so a forged Host header
 * can at most select this instance's own tailnet origin, never another site.
 */
export function tailscaleRequestOrigin(
  headers: Headers | undefined,
  trustedOrigin: string | null,
): string | null {
  const host = headers?.get('host')?.trim();
  if (!host || !trustedOrigin) return null;
  let requestHost: string;
  try {
    // Normalizes case and drops the default `:443` port.
    requestHost = new URL(`https://${host}`).host;
  } catch {
    return null;
  }
  return requestHost === new URL(trustedOrigin).host ? trustedOrigin : null;
}

type DeviceGrant = {
  verification_uri: string;
  verification_uri_complete: string;
};

function isDeviceGrant(value: unknown): value is DeviceGrant {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant.verification_uri === 'string' &&
    typeof grant.verification_uri_complete === 'string'
  );
}

function rebase(value: string, origin: string) {
  const url = new URL(value);
  return new URL(`${url.pathname}${url.search}`, origin).href;
}

/** Move a device grant's verification URLs onto `origin`, keeping path and code. */
export function rebaseDeviceGrant<T>(grant: T, origin: string): T | null {
  if (!isDeviceGrant(grant)) return null;
  return {
    ...grant,
    verification_uri: rebase(grant.verification_uri, origin),
    verification_uri_complete: rebase(grant.verification_uri_complete, origin),
  };
}
