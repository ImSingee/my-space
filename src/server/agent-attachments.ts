/** Platform-side storage manager for non-image Agent chat attachments. */
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AgentAttachmentRef } from '~agent/attachments';
import { safeAttachmentName } from '~agent/attachments';
import {
  AGENT_ATTACHMENTS_DIR,
  agentAttachmentStoreDir,
  agentAttachmentStorePath,
} from '~agent/paths';
import { AppError } from './errors';

export const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const ATTACHMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function requireAttachmentId(id: string): string {
  if (!ATTACHMENT_ID_RE.test(id)) {
    throw new AppError('Invalid attachment id.', 400);
  }
  return id;
}

function asRef(
  row: typeof schema.agentAttachments.$inferSelect,
): AgentAttachmentRef {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.contentType,
    size: row.size,
  };
}

async function writeCappedUpload(
  body: ReadableStream<Uint8Array> | null,
  target: string,
): Promise<{ size: number; temp: string }> {
  if (!body) throw new AppError('Attachment body is required.', 400);
  const temp = `${target}.${crypto.randomUUID()}.upload`;
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(temp, 'wx');
  let size = 0;
  let complete = false;
  try {
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_AGENT_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new AppError('Attachment is too large.', 413);
      }
      await writeChunkFully(handle, value);
    }
    if (size === 0) throw new AppError('Attachment is empty.', 400);
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await rm(temp, { force: true });
  }
  return { size, temp };
}

export async function writeChunkFully(
  handle: {
    write(
      buffer: Uint8Array,
      offset: number,
      length: number,
    ): Promise<{ bytesWritten: number }>;
  },
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const remaining = value.byteLength - offset;
    const { bytesWritten } = await handle.write(value, offset, remaining);
    if (bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error('Could not write the complete attachment body.');
    }
    offset += bytesWritten;
  }
}

async function storedFileMatches(
  target: string,
  size: number,
): Promise<boolean> {
  try {
    const metadata = await stat(target);
    return metadata.isFile() && metadata.size === size;
  } catch {
    return false;
  }
}

export async function uploadAgentAttachment(input: {
  id: string;
  sessionId: string;
  name: string;
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
  declaredBytes?: number;
}): Promise<AgentAttachmentRef> {
  const id = requireAttachmentId(input.id);
  if (
    input.declaredBytes != null &&
    input.declaredBytes > MAX_AGENT_ATTACHMENT_BYTES
  ) {
    throw new AppError('Attachment is too large.', 413);
  }

  const session = await db.query.agentSessions.findFirst({
    where: (row, { eq: equals }) => equals(row.id, input.sessionId),
    columns: { id: true },
  });
  if (!session) throw new AppError('Session not found.', 404);

  const existing = await db.query.agentAttachments.findFirst({
    where: (row, { eq: equals }) => equals(row.id, id),
  });
  if (
    existing &&
    (existing.sessionId !== input.sessionId || existing.attachedAt != null)
  ) {
    throw new AppError('Attachment id is already in use.', 409);
  }

  const name = safeAttachmentName(input.name);
  const contentType =
    input.contentType.trim().slice(0, 255) || 'application/octet-stream';
  const target = agentAttachmentStorePath(input.sessionId, id);
  const { size, temp } = await writeCappedUpload(input.body, target);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [locked] = await tx
        .select()
        .from(schema.agentAttachments)
        .where(eq(schema.agentAttachments.id, id))
        .for('update');
      if (
        locked &&
        (locked.sessionId !== input.sessionId || locked.attachedAt != null)
      ) {
        throw new AppError('Attachment id is already in use.', 409);
      }

      // A repeated PUT for the same pending id is an idempotent retry. Keep the
      // first complete object rather than replacing it with whichever request
      // wins a network race. A missing/truncated file is repaired below.
      if (locked && (await storedFileMatches(target, locked.size))) {
        return asRef(locked);
      }

      await rename(temp, target);
      try {
        if (locked) {
          const [updated] = await tx
            .update(schema.agentAttachments)
            .set({ name, contentType, size })
            .where(eq(schema.agentAttachments.id, id))
            .returning();
          return asRef(updated);
        }
        const [inserted] = await tx
          .insert(schema.agentAttachments)
          .values({ id, sessionId: input.sessionId, name, contentType, size })
          .returning();
        return asRef(inserted);
      } catch (error) {
        // Keep compensation under the advisory lock so a concurrent retry
        // cannot write a valid replacement that this request then removes.
        await rm(target, { force: true });
        throw error;
      }
    });
  } finally {
    await rm(temp, { force: true });
  }
}

export async function getAgentAttachment(
  id: string,
  sessionId?: string,
): Promise<{ attachment: AgentAttachmentRef; body: Uint8Array } | null> {
  requireAttachmentId(id);
  const row = await db.query.agentAttachments.findFirst({
    where: (attachment, { and: all, eq: equals }) =>
      sessionId
        ? all(
            equals(attachment.id, id),
            equals(attachment.sessionId, sessionId),
          )
        : equals(attachment.id, id),
  });
  if (!row) return null;
  try {
    return {
      attachment: asRef(row),
      body: new Uint8Array(
        await readFile(agentAttachmentStorePath(row.sessionId, row.id)),
      ),
    };
  } catch {
    return null;
  }
}

export async function deleteAgentSessionAttachments(
  sessionId: string,
): Promise<void> {
  await rm(agentAttachmentStoreDir(sessionId), {
    recursive: true,
    force: true,
  });
}

/** Recover attachment directories left by a crash after session DB deletion. */
export async function pruneOrphanedAgentAttachmentSessions(): Promise<number> {
  let entries;
  try {
    entries = await readdir(AGENT_ATTACHMENTS_DIR, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const sessions = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions);
  const existing = new Set(sessions.map((session) => session.id));
  let pruned = 0;
  for (const entry of entries) {
    if (existing.has(entry.name)) continue;
    const target = path.resolve(AGENT_ATTACHMENTS_DIR, entry.name);
    const relative = path.relative(AGENT_ATTACHMENTS_DIR, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    await rm(target, { recursive: true, force: true });
    pruned += 1;
  }
  return pruned;
}

export async function prunePendingAgentAttachments(
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_ATTACHMENT_TTL_MS);
  const candidates = await db
    .select()
    .from(schema.agentAttachments)
    .where(
      and(
        isNull(schema.agentAttachments.attachedAt),
        lt(schema.agentAttachments.createdAt, cutoff),
      ),
    );
  let pruned = 0;
  for (const candidate of candidates) {
    const target = agentAttachmentStorePath(candidate.sessionId, candidate.id);
    const tombstone = `${target}.${crypto.randomUUID()}.prune`;
    let moved = false;
    const deleted = await db.transaction(async (tx) => {
      // Uploads take the same id-scoped advisory lock. Rename the old body out
      // of the canonical path before releasing it, so a retry that starts after
      // this prune can safely write a new object without our cleanup deleting it.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${candidate.id}))`,
      );
      const [locked] = await tx
        .select()
        .from(schema.agentAttachments)
        .where(
          and(
            eq(schema.agentAttachments.id, candidate.id),
            isNull(schema.agentAttachments.attachedAt),
            lt(schema.agentAttachments.createdAt, cutoff),
          ),
        )
        .for('update');
      if (!locked) return false;
      try {
        await rename(target, tombstone);
        moved = true;
      } catch (error) {
        // A missing body should not pin a stale pending database row forever.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await tx
          .delete(schema.agentAttachments)
          .where(eq(schema.agentAttachments.id, candidate.id));
      } catch (error) {
        if (moved) {
          await rename(tombstone, target);
          moved = false;
        }
        throw error;
      }
      return true;
    });
    await rm(tombstone, { force: true });
    if (deleted) pruned += 1;
  }
  return pruned;
}

export function attachmentDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}
