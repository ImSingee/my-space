/**
 * Minimal APNs provider client over HTTP/2 with token (JWT) authentication.
 * Uses only Node built-ins; one session per APNs origin is reused.
 */
import { randomUUID, sign } from 'node:crypto';
import http2, { type ClientHttp2Session } from 'node:http2';
import type { NotificationApnsEnvironment } from '~/db/schema';
import type { ApnsKey } from './credentials';

export const APNS_ORIGINS: Record<NotificationApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple accepts provider tokens for 60 minutes; refresh well before that. */
const TOKEN_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type ApnsSendResult = {
  status: number;
  /** Apple's `reason` for a rejected request. */
  reason: string | null;
};

export type ApnsSendRequest = {
  origin: string;
  teamId: string;
  key: ApnsKey;
  topic: string;
  deviceToken: string;
  payload: string;
  collapseId: string;
  expiresAt: Date;
  /** Extra TLS options, used by tests that run a local HTTP/2 server. */
  connectOptions?: http2.SecureClientSessionOptions;
};

const tokenCache = new Map<string, { token: string; issuedAt: number }>();

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** ES256 provider token: header `{alg, kid}`, claims `{iss: teamId, iat}`. */
export function providerToken(teamId: string, key: ApnsKey, now = Date.now()) {
  const cacheKey = `${teamId}:${key.keyId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && now - cached.issuedAt < TOKEN_TTL_MS) return cached.token;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: key.key,
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${header}.${claims}.${base64url(signature)}`;
  tokenCache.set(cacheKey, { token, issuedAt: now });
  return token;
}

/** Drop a token Apple reported as expired so the next attempt re-signs. */
export function invalidateProviderToken(teamId: string, key: ApnsKey) {
  tokenCache.delete(`${teamId}:${key.keyId}`);
}

const sessions = new Map<string, ClientHttp2Session>();

function session(
  origin: string,
  options?: http2.SecureClientSessionOptions,
): ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const created = http2.connect(origin, options);
  const forget = () => {
    if (sessions.get(origin) === created) sessions.delete(origin);
  };
  created.on('close', forget);
  created.on('error', forget);
  created.on('goaway', forget);
  created.unref();
  sessions.set(origin, created);
  return created;
}

/** Close cached sessions (process shutdown and tests). */
export function closeApnsSessions() {
  for (const current of sessions.values()) current.close();
  sessions.clear();
}

export function sendApnsRequest(
  request: ApnsSendRequest,
): Promise<ApnsSendResult> {
  return new Promise((resolve, reject) => {
    let client: ClientHttp2Session;
    try {
      client = session(request.origin, request.connectOptions);
    } catch (error) {
      reject(error);
      return;
    }
    client.ref();
    const stream = client.request({
      ':method': 'POST',
      ':path': `/3/device/${request.deviceToken}`,
      authorization: `bearer ${providerToken(request.teamId, request.key)}`,
      'apns-topic': request.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-id': randomUUID(),
      'apns-collapse-id': request.collapseId,
      'apns-expiration': String(Math.floor(request.expiresAt.getTime() / 1000)),
      'content-type': 'application/json',
    });
    let status = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.unref();
      reject(error);
    };
    stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      fail(new Error('APNs request timed out.'));
    });
    stream.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    stream.on('data', (chunk: Buffer) => {
      if (chunks.length < 16) chunks.push(chunk);
    });
    stream.on('error', fail);
    // A stream reset before response headers ends without an error event;
    // treat it as a transport failure so the delivery is retried.
    stream.on('close', () =>
      fail(new Error('APNs closed the stream without a response.')),
    );
    stream.on('end', () => {
      if (settled) return;
      if (status < 100) {
        fail(new Error('APNs closed the stream without a response.'));
        return;
      }
      settled = true;
      let reason: string | null = null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) {
        try {
          const parsed = JSON.parse(text) as { reason?: unknown };
          if (typeof parsed.reason === 'string') reason = parsed.reason;
        } catch {
          reason = text.slice(0, 200);
        }
      }
      client.unref();
      resolve({ status, reason });
    });
    stream.end(request.payload);
  });
}
