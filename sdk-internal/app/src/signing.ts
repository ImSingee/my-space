/** HMAC-SHA256 request signing shared by App backend clients. */

type DenoRuntime = typeof globalThis & {
  Deno?: { env?: { get(name: string): string | undefined } };
};

/** Read a platform-injected backend environment variable, if any. */
export function runtimeEnv(name: string): string | undefined {
  try {
    return (globalThis as DenoRuntime).Deno?.env?.get(name) || undefined;
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** Headers proving `<timestamp>.<body>` was signed with the App secret. */
export async function hmacHeaders(
  secret: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = String(Date.now());
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    'x-hatch-timestamp': timestamp,
    'x-hatch-signature': `sha256=${hex}`,
  };
}

/** Constant-time check of a platform `x-hatch-signature` over raw bytes. */
export async function verifyHmac(args: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  maxSkewMs: number;
}): Promise<boolean> {
  const { secret, timestamp, signature, body, maxSkewMs } = args;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > maxSkewMs) {
    return false;
  }
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return false;
  const bytes = new Uint8Array(
    match[1].match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    bytes,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
}
