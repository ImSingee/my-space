const ORIGIN_REQUIREMENT =
  'Passkeys require an HTTPS domain or localhost. IP addresses are not supported.';

/** Shared by the server gate and browser UI; never import server auth here. */
export function getPasskeyRpId(origin: string): string | undefined {
  try {
    // URL normalizes alternate IPv4 spellings (e.g. 127.1 and 0x7f000001).
    const { hostname, protocol } = new URL(origin);
    if (hostname.startsWith('[') || /^[\d.]+$/.test(hostname)) return;

    const labels = hostname.replace(/\.$/, '').split('.');
    if (
      labels.some(
        (label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
      )
    ) {
      return;
    }

    const local = hostname === 'localhost' || hostname.endsWith('.localhost');
    if (protocol !== 'https:' && !(protocol === 'http:' && local)) return;

    return hostname;
  } catch {
    return;
  }
}

export function getPasskeyOriginError(
  appOrigin: string,
  requestOrigin?: string,
): string | undefined {
  if (!getPasskeyRpId(appOrigin)) return ORIGIN_REQUIREMENT;
  if (requestOrigin === undefined) return;
  if (!getPasskeyRpId(requestOrigin)) return ORIGIN_REQUIREMENT;
}
