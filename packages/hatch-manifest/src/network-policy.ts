import { z } from 'zod';

export type NetworkPolicy = 'unrestricted' | string[];

export type NetworkAccessView = {
  mode: 'blocked' | 'restricted' | 'unrestricted';
  destinations: string[];
  legacy: boolean;
};

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function normalizePort(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? String(port)
    : null;
}

function normalizeIpv4(value: string): string | null {
  if (!IPV4_RE.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255)
    ? parts.join('.')
    : null;
}

function normalizeHostname(value: string): string | null {
  if (value.length > 253 || value.endsWith('.')) return null;
  const labels = value.split('.');
  if (labels.some((label) => !HOST_LABEL_RE.test(label))) return null;
  // Numeric dotted values must be valid IPv4 addresses rather than ambiguous
  // hostnames that Deno or the OS could interpret differently.
  if (labels.every((label) => /^\d+$/.test(label))) {
    return normalizeIpv4(value);
  }
  return value.toLowerCase();
}

function normalizeBracketedIpv6(value: string): string | null {
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalize the supported Deno host/IP permission subset. Protocols, paths,
 * CIDR ranges, Unix sockets, and unbracketed IPv6 are deliberately excluded.
 */
export function normalizeNetworkDestination(value: string): string | null {
  const input = value.trim();
  if (input.length === 0 || /[\s,/?#@]/.test(input) || input.includes('://')) {
    return null;
  }

  let host: string;
  let port: string | null = null;

  if (input.startsWith('[')) {
    const close = input.indexOf(']');
    if (close < 0) return null;
    host = input.slice(0, close + 1);
    const suffix = input.slice(close + 1);
    if (suffix) {
      if (!suffix.startsWith(':')) return null;
      port = normalizePort(suffix.slice(1));
      if (!port) return null;
    }
    host = normalizeBracketedIpv6(host) ?? '';
  } else {
    if (input.includes('[') || input.includes(']')) return null;
    const firstColon = input.indexOf(':');
    const lastColon = input.lastIndexOf(':');
    if (firstColon !== lastColon) return null;
    if (lastColon >= 0) {
      host = input.slice(0, lastColon);
      port = normalizePort(input.slice(lastColon + 1));
      if (!port) return null;
    } else {
      host = input;
    }

    if (host.startsWith('*.')) {
      const base = normalizeHostname(host.slice(2));
      if (!base || normalizeIpv4(base)) return null;
      host = `*.${base}`;
    } else {
      host = normalizeIpv4(host) ?? normalizeHostname(host) ?? '';
    }
  }

  if (!host) return null;
  return port ? `${host}:${port}` : host;
}

export const networkDestinationSchema = z
  .string()
  .trim()
  .refine((value) => normalizeNetworkDestination(value) !== null, {
    message:
      'must be a hostname, wildcard subdomain, IPv4, or bracketed IPv6 address, optionally with a port',
  })
  .transform((value) => normalizeNetworkDestination(value) as string);

export const networkPolicySchema = z.union([
  z.literal('unrestricted'),
  z
    .array(networkDestinationSchema)
    .transform((destinations) => [...new Set(destinations)]),
]);

/** Project a persisted declaration into the stable UI/Agent read model. */
export function networkAccessView(
  policy: NetworkPolicy | undefined,
): NetworkAccessView {
  if (policy === undefined) {
    return { mode: 'unrestricted', destinations: [], legacy: true };
  }
  if (policy === 'unrestricted') {
    return { mode: 'unrestricted', destinations: [], legacy: false };
  }
  return {
    mode: policy.length === 0 ? 'blocked' : 'restricted',
    destinations: [...policy],
    legacy: false,
  };
}

/**
 * Resolve the effective Deno allowlist. `null` means a bare `--allow-net`;
 * an empty array means no network permission flag at all.
 */
export function effectiveNetworkAllowlist(
  policy: NetworkPolicy | undefined,
  automaticDestinations: readonly string[] = [],
): string[] | null {
  if (policy === undefined || policy === 'unrestricted') return null;
  return [...new Set([...automaticDestinations, ...policy])];
}

/** Convert an injected platform/database URL into a Deno host:port target. */
export function networkDestinationFromUrl(value: string): string {
  const url = new URL(value);
  if (!url.hostname) throw new Error(`Network URL has no hostname: ${value}`);
  const defaultPort: Record<string, string> = {
    'http:': '80',
    'https:': '443',
    'postgres:': '5432',
    'postgresql:': '5432',
  };
  const port = url.port || defaultPort[url.protocol];
  if (!port) {
    throw new Error(`Network URL has no known port: ${value}`);
  }
  return `${url.hostname.toLowerCase()}:${port}`;
}
