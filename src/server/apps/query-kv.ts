/**
 * Server-only: execute Agent KV operations against the platform database.
 * The Agent Runner reaches this through the bearer-authenticated internal API;
 * unlike the manage UI, this trusted surface intentionally returns secret
 * values in plaintext so the Agent can inspect and maintain app configuration.
 */
import { db } from '~/db';
import type {
  ParsedQueryAppKvRequest,
  QueryAppKvRecord,
  QueryAppKvResponse,
} from '~agent/protocol';
import { AppError } from '~server/errors';
import { deleteKv, getKv, listKvPage, setKv } from './kv';

/** Approximate model-context budget for one list response. */
export const MAX_KV_QUERY_CHARS = 60000;
/** Bound plaintext fetched ahead of the response budget to roughly 704 KiB. */
const KV_QUERY_BATCH_SIZE = 10;

async function requireKvEnabledApp(id: string): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, id),
    columns: { status: true, capabilities: true },
  });
  if (!app || app.status === 'archived' || !app.capabilities?.kv) {
    throw new AppError(
      `App "${id}" not found or does not have KV enabled.`,
      404,
    );
  }
}

async function listKvForAgent(
  id: string,
  cursor: string | undefined,
  limit: number,
): Promise<{ items: QueryAppKvRecord[]; nextCursor: string | null }> {
  const items: QueryAppKvRecord[] = [];
  let after = cursor;
  let hasMore = true;

  while (items.length < limit && hasMore) {
    const batch = await listKvPage(id, {
      after,
      limit: Math.min(KV_QUERY_BATCH_SIZE, limit - items.length),
    });
    hasMore = batch.hasMore;

    for (const record of batch.items) {
      const candidate = [...items, record];
      // Always return at least one complete record so a value larger than the
      // approximate context budget cannot make pagination stall forever.
      if (
        items.length > 0 &&
        JSON.stringify(candidate, null, 2).length > MAX_KV_QUERY_CHARS
      ) {
        return { items, nextCursor: items.at(-1)?.key ?? null };
      }
      items.push(record);
      after = record.key;
    }
  }

  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.key ?? null) : null,
  };
}

export async function queryAppKv(
  id: string,
  input: ParsedQueryAppKvRequest,
): Promise<QueryAppKvResponse> {
  await requireKvEnabledApp(id);

  switch (input.action) {
    case 'list': {
      return {
        action: 'list',
        ...(await listKvForAgent(id, input.cursor, input.limit)),
      };
    }
    case 'get':
      return { action: 'get', record: await getKv(id, input.key) };
    case 'set':
      return {
        action: 'set',
        record: await setKv(id, input.key, input.value, {
          secret: input.secret,
        }),
      };
    case 'delete':
      return { action: 'delete', ok: await deleteKv(id, input.key) };
  }
}
