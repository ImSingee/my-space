import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '~auth/server';
import type { ApiKeySummary } from '~auth/api-key-contract';
import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_LIFETIME_SECONDS,
} from '~auth/api-key-contract';
import { db, schema } from '~/db';

const createInput = z
  .object({
    name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
    expiresIn: z
      .number()
      .int()
      .min(1)
      .max(API_KEY_MAX_LIFETIME_SECONDS)
      .nullable(),
  })
  .strict();
const revokeInput = z.object({ id: z.string().min(1).max(191) }).strict();

const columns = {
  id: true,
  name: true,
  prefix: true,
  start: true,
  createdAt: true,
  expiresAt: true,
  lastRequest: true,
} as const;

function summary(row: {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequest: Date | null;
}): ApiKeySummary {
  return {
    id: row.id,
    name: row.name ?? '',
    prefix: row.prefix ?? '',
    start: row.start ?? '',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRequest: row.lastRequest?.toISOString() ?? null,
  };
}
function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/** Session-only credential management; never accept a key as an identity. */
export async function handleApiKeysRequest(
  request: Request,
): Promise<Response> {
  try {
    if (request.headers.has('x-api-key'))
      return json({ error: 'unauthorized' }, 401);
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (!session) return json({ error: 'unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    if (path === '/api/settings/api-keys' && request.method === 'GET') {
      const rows = await db.query.apikey.findMany({
        where: { referenceId: session.user.id, configId: 'default' },
        columns,
        orderBy: { createdAt: 'desc' },
      });
      return json({ keys: rows.map(summary) });
    }
    if (
      request.method !== 'POST' ||
      !['/api/settings/api-keys', '/api/settings/api-keys/revoke'].includes(
        path,
      )
    )
      return json({ error: 'not_found' }, 404);
    // JSON plus a same-origin check prevents cross-site credential mutations.
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      return json({ error: 'forbidden' }, 403);
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return json({ error: 'json_required' }, 415);
    const text = await readBody(request);
    if (text === null) return json({ error: 'payload_too_large' }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: 'invalid_request' }, 400);
    }
    if (path.endsWith('/revoke')) {
      const { id } = revokeInput.parse(raw);
      const deleted = await db
        .delete(schema.apikey)
        .where(
          and(
            eq(schema.apikey.id, id),
            eq(schema.apikey.referenceId, session.user.id),
            eq(schema.apikey.configId, 'default'),
          ),
        )
        .returning({ id: schema.apikey.id });
      if (!deleted.length) return json({ error: 'key_not_found' }, 404);
      return json({ success: true });
    }
    const input = createInput.parse(raw);
    // Only this server-selected identity and fixed configuration reach the plugin.
    const created = await auth.api.createApiKey({
      body: {
        userId: session.user.id,
        name: input.name,
        expiresIn: input.expiresIn,
      },
    });
    return json({ apiKey: summary(created), key: created.key });
  } catch (error) {
    if (error instanceof z.ZodError)
      return json({ error: 'invalid_request' }, 400);
    // Do not serialize plugin errors or log request bodies/secret material.
    return json({ error: 'request_failed' }, 500);
  }
}
