import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-attachments-'));
process.env.HATCH_DATA_DIR = root;

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  PENDING_ATTACHMENT_TTL_MS,
  deleteAgentSessionAttachments,
  getAgentAttachment,
  pruneOrphanedAgentAttachmentSessions,
  prunePendingAgentAttachments,
  uploadAgentAttachment,
  writeChunkFully,
} = await import('./agent-attachments');
const { agentAttachmentStoreDir, agentAttachmentStorePath } =
  await import('~agent/paths');

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function seedSession(id: string): Promise<void> {
  await db
    .insert(schema.agentSessions)
    .values({ id, title: 'Attachment test' });
}

async function upload(input: {
  id: string;
  sessionId: string;
  bytes: Uint8Array;
  name?: string;
  contentType?: string;
}) {
  return uploadAgentAttachment({
    id: input.id,
    sessionId: input.sessionId,
    name: input.name ?? 'payload.bin',
    contentType: input.contentType ?? 'application/octet-stream',
    body: stream(input.bytes),
    declaredBytes: input.bytes.byteLength,
  });
}

beforeEach(async () => {
  await db.delete(schema.agentAttachments);
  await db.delete(schema.agentSessions);
  await rm(path.join(root, 'agent-attachments'), {
    recursive: true,
    force: true,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Agent attachment manager', () => {
  it('writes every byte when the filesystem reports partial writes', async () => {
    const output: number[] = [];
    const offsets: number[] = [];
    const handle = {
      write: async (buffer: Uint8Array, offset: number, length: number) => {
        offsets.push(offset);
        const bytesWritten = Math.min(length, 2);
        output.push(...buffer.slice(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };

    await writeChunkFully(handle, Uint8Array.from([0, 1, 2, 3, 4]));

    expect(offsets).toEqual([0, 2, 4]);
    expect(output).toEqual([0, 1, 2, 3, 4]);
  });

  it('stores arbitrary binary bytes and returns safe metadata', async () => {
    await seedSession('session-binary');
    const bytes = Uint8Array.from([0, 1, 2, 255, 0, 128, 10]);

    const attachment = await upload({
      id: 'binary-file',
      sessionId: 'session-binary',
      bytes,
      name: '../../report final?.bin',
      contentType: 'application/x-test',
    });

    expect(attachment).toEqual({
      id: 'binary-file',
      name: 'report-final-.bin',
      mimeType: 'application/x-test',
      size: bytes.byteLength,
    });
    const got = await getAgentAttachment('binary-file', 'session-binary');
    expect(got?.attachment).toEqual(attachment);
    expect(got?.body).toEqual(bytes);
    await expect(
      readFile(agentAttachmentStorePath('session-binary', 'binary-file')),
    ).resolves.toEqual(Buffer.from(bytes));
  });

  it('treats a repeated pending PUT as an idempotent retry', async () => {
    await seedSession('session-retry');
    const original = Uint8Array.from([1, 2, 3, 4]);
    const first = await upload({
      id: 'same-id',
      sessionId: 'session-retry',
      bytes: original,
      name: 'first.bin',
    });

    const repeated = await upload({
      id: 'same-id',
      sessionId: 'session-retry',
      bytes: Uint8Array.from([9, 9, 9]),
      name: 'different.bin',
    });

    expect(repeated).toEqual(first);
    expect((await getAgentAttachment('same-id'))?.body).toEqual(original);
    expect(await db.query.agentAttachments.findMany()).toHaveLength(1);
  });

  it('scopes ids and downloads to their owning session', async () => {
    await seedSession('session-a');
    await seedSession('session-b');
    await upload({
      id: 'scoped-id',
      sessionId: 'session-a',
      bytes: Uint8Array.from([7]),
    });

    await expect(
      upload({
        id: 'scoped-id',
        sessionId: 'session-b',
        bytes: Uint8Array.from([8]),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      getAgentAttachment('scoped-id', 'session-b'),
    ).resolves.toBeNull();
    expect((await getAgentAttachment('scoped-id', 'session-a'))?.body).toEqual(
      Uint8Array.from([7]),
    );
  });

  it('prunes only unreferenced uploads older than 24 hours', async () => {
    await seedSession('session-prune');
    const now = new Date('2026-07-12T00:00:00.000Z');
    const old = new Date(now.getTime() - PENDING_ATTACHMENT_TTL_MS - 1);
    for (const id of ['pending-old', 'attached-old', 'pending-fresh']) {
      await upload({
        id,
        sessionId: 'session-prune',
        bytes: Uint8Array.from([id.length]),
      });
    }
    await db
      .update(schema.agentAttachments)
      .set({ createdAt: old })
      .where(
        inArray(schema.agentAttachments.id, ['pending-old', 'attached-old']),
      );
    await db
      .update(schema.agentAttachments)
      .set({ attachedAt: old })
      .where(eq(schema.agentAttachments.id, 'attached-old'));

    await expect(prunePendingAgentAttachments(now)).resolves.toBe(1);
    await expect(
      getAgentAttachment('pending-old', 'session-prune'),
    ).resolves.toBeNull();
    await expect(
      getAgentAttachment('attached-old', 'session-prune'),
    ).resolves.not.toBeNull();
    await expect(
      getAgentAttachment('pending-fresh', 'session-prune'),
    ).resolves.not.toBeNull();
  });

  it('removes every stored body for a deleted session', async () => {
    await seedSession('session-delete');
    await upload({
      id: 'delete-me',
      sessionId: 'session-delete',
      bytes: Uint8Array.from([4, 2]),
    });

    await deleteAgentSessionAttachments('session-delete');

    await expect(
      readFile(agentAttachmentStorePath('session-delete', 'delete-me')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prunes attachment directories whose session row is gone', async () => {
    await seedSession('session-live');
    const live = agentAttachmentStoreDir('session-live');
    const orphan = agentAttachmentStoreDir('session-orphan');
    await mkdir(live, { recursive: true });
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(live, 'keep'), 'live');
    await writeFile(path.join(orphan, 'remove'), 'orphan');

    await expect(pruneOrphanedAgentAttachmentSessions()).resolves.toBe(1);
    await expect(readFile(path.join(live, 'keep'), 'utf8')).resolves.toBe(
      'live',
    );
    await expect(
      readFile(path.join(orphan, 'remove'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a session path that would escape the attachment root', async () => {
    const sentinel = path.join(root, 'keep-me');
    await writeFile(sentinel, 'safe');

    await expect(deleteAgentSessionAttachments('..')).rejects.toThrow(
      'Invalid Agent attachment session id.',
    );
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('safe');
  });
});
