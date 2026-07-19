import { createFileRoute } from '@tanstack/react-router';

// Cap inbound KV bodies: this endpoint authenticates with only the per-app HMAC
// signature, so without a limit any caller could stream an unbounded body and
// exhaust server memory before the signature is even verified. Generous vs the
// 64 KB per-value cap because JSON string-escaping can inflate a value; the
// precise per-value limit is still enforced in setKv after decode.
const MAX_KV_BODY = 1_000_000;

/**
 * Read a request body as text, returning null once `max` bytes are exceeded so
 * the caller can reject oversized payloads instead of buffering them whole.
 * Mirrors the inbound webhook route's capped reader.
 */
async function readCappedText(
  request: Request,
  max: number,
): Promise<string | null> {
  const body = request.body;
  if (!body) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > max ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * App-facing KV REST endpoint. Called by the app's OWN backend (never the
 * browser), authenticated with the per-app HMAC signing secret — the same
 * `HATCH_SIGNING_SECRET` the platform uses for cron/webhook handshakes. The
 * backend signs `<timestamp>.<rawBody>` (empty body for GET/DELETE); the
 * platform verifies it against the app's `signingSecret`, so only the app
 * holding its own secret can reach its own KV (the app id in the path + per-app
 * secret prevents cross-app access).
 *
 *   GET    /api/apps/<id>/kv        → { items: KvRecord[] }   (list)
 *   GET    /api/apps/<id>/kv/<key>  → KvRecord | 404          (read)
 *   PUT    /api/apps/<id>/kv/<key>  → KvRecord                (upsert; body {value, secret?})
 *   DELETE /api/apps/<id>/kv/<key>  → { ok: boolean }         (delete)
 *
 * The manage UI does NOT use this route — it reads/writes via session-authed
 * server functions and masks `secret` values. The backend always sees plaintext.
 */
function parse(request: Request): { id: string; key: string } | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/apps\/([^/]+)\/kv\/?(.*)$/);
  if (!match) return null;
  return { id: match[1], key: decodeURIComponent(match[2] || '') };
}

export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const parsed = parse(request);
  if (!parsed) return new Response('Not found', { status: 404 });
  const { id, key } = parsed;

  const { db } = await import('~/db');
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: {
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      signingSecret: true,
    },
  });
  // Gate on a live, kv-capable, non-archived app (mirrors the webhook route) so
  // a stale URL can't reach a retired or non-kv app.
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.kv
  ) {
    return new Response('Not found', { status: 404 });
  }
  // Without a signing secret there's no way to authenticate the caller (only
  // backend-capable apps mint one), so KV is unreachable from app code.
  if (!app.signingSecret) {
    return new Response('KV requires a backend', { status: 404 });
  }

  // Read the raw body (PUT/POST only) so the signature is verified over the
  // exact bytes the backend signed. KV bodies are always JSON (UTF-8), so the
  // string round-trip is lossless. Cap the read BEFORE verifying so an oversized
  // (and necessarily unsigned-or-not-yet-trusted) body can't exhaust memory.
  const hasBody = request.method === 'PUT' || request.method === 'POST';
  let rawBody = '';
  if (hasBody) {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_KV_BODY) {
      return new Response('Payload too large', { status: 413 });
    }
    const text = await readCappedText(request, MAX_KV_BODY);
    if (text === null) {
      return new Response('Payload too large', { status: 413 });
    }
    rawBody = text;
  }

  const {
    verifyHatchSignature,
    HATCH_TIMESTAMP_HEADER,
    HATCH_SIGNATURE_HEADER,
  } = await import('~server/secrets');
  const verified = verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  });
  if (!verified) return new Response('Forbidden', { status: 403 });

  const kv = await import('~server/apps/kv');
  try {
    if (request.method === 'GET') {
      if (!key) return Response.json({ items: await kv.listKv(id) });
      const rec = await kv.getKv(id, key);
      if (!rec) return new Response('Not found', { status: 404 });
      return Response.json(rec);
    }

    if (hasBody) {
      if (!key) return new Response('KV key required', { status: 400 });
      let body: { value?: unknown; secret?: unknown };
      try {
        body = rawBody ? (JSON.parse(rawBody) as typeof body) : {};
      } catch {
        return new Response('Invalid JSON body', { status: 400 });
      }
      const secret = typeof body.secret === 'boolean' ? body.secret : undefined;
      const rec = await kv.setKv(id, key, body.value as string, { secret });
      return Response.json(rec);
    }

    if (request.method === 'DELETE') {
      if (!key) return new Response('KV key required', { status: 400 });
      return Response.json({ ok: await kv.deleteKv(id, key) });
    }

    return new Response('Method not allowed', { status: 405 });
  } catch (error) {
    // KvError extends AppError, so its status flows through automatically.
    const { errorResponse } = await import('~server/errors');
    return errorResponse(error, 400);
  }
}

export const Route = createFileRoute('/api/apps/$appId/kv/$')({
  server: {
    handlers: {
      GET: handle,
      PUT: handle,
      POST: handle,
      DELETE: handle,
    },
  },
});
