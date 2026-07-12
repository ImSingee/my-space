import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from '../platform-client';

const root = await realpath(
  await mkdtemp(path.join(tmpdir(), 'hatch-attachment-tool-')),
);
process.env.HATCH_DATA_DIR = root;

const { agentWorkDir } = await import('../paths');
const { createAttachmentTool } = await import('./attachments');

const sessionId = 'attachment-tool-session';
const cwd = agentWorkDir(sessionId);
await mkdir(cwd, { recursive: true });

const downloadAttachment = vi.fn<PlatformClient['downloadAttachment']>(
  async (_sessionId, attachmentId) => ({
    id: attachmentId,
    name: '../../unsafe name.bin',
    mimeType: 'application/octet-stream',
    size: 6,
    body: Uint8Array.from([0, 1, 2, 255, 0, 9]),
  }),
);
const platform = { downloadAttachment } as unknown as PlatformClient;
const tool = createAttachmentTool({ sessionId, platform });

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('download_attachment', () => {
  it('writes binary bytes to the safe default attachment path', async () => {
    const result = await tool.execute('download-default', {
      attachment_id: 'attachment-a',
    });

    const expected = path.join(
      cwd,
      'attachments',
      'attachment-a',
      'unsafe-name.bin',
    );
    await expect(readFile(expected)).resolves.toEqual(
      Buffer.from([0, 1, 2, 255, 0, 9]),
    );
    expect(downloadAttachment).toHaveBeenCalledWith(
      sessionId,
      'attachment-a',
      undefined,
    );
    expect(result.details).toMatchObject({
      attachmentId: 'attachment-a',
      path: 'attachments/attachment-a/unsafe-name.bin',
      absolutePath: expected,
      name: 'unsafe-name.bin',
    });
  });

  it('accepts a custom relative path inside the Agent workdir', async () => {
    const result = await tool.execute('download-custom', {
      attachment_id: 'attachment-b',
      path: 'imports/source.bin',
    });

    await expect(
      readFile(path.join(cwd, 'imports/source.bin')),
    ).resolves.toEqual(Buffer.from([0, 1, 2, 255, 0, 9]));
    expect(result.details).toMatchObject({ path: 'imports/source.bin' });
  });

  it('rejects lexical and symlink escapes from the Agent workdir', async () => {
    await expect(
      tool.execute('download-parent', {
        attachment_id: 'attachment-c',
        path: '../outside.bin',
      }),
    ).rejects.toThrow(/inside the Agent workdir/);

    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(cwd, 'outside-link'));
    await expect(
      tool.execute('download-symlink', {
        attachment_id: 'attachment-d',
        path: 'outside-link/escaped.bin',
      }),
    ).rejects.toThrow(/escapes the Agent workdir through a symlink/);
  });

  it('rejects a parent replaced by a symlink after path resolution', async () => {
    const { resolveAgentWorkspacePath, writeResolvedAgentWorkspaceFile } =
      await import('../workspace-paths');
    const parent = path.join(cwd, 'race-parent');
    await mkdir(parent, { recursive: true });
    const destination = await resolveAgentWorkspacePath(
      sessionId,
      'race-parent/escaped.bin',
    );
    const outside = path.join(root, 'race-outside');
    await mkdir(outside, { recursive: true });
    await rm(parent, { recursive: true });
    await symlink(outside, parent);

    await expect(
      writeResolvedAgentWorkspaceFile(destination, Uint8Array.from([1, 2, 3])),
    ).rejects.toThrow(/escaped the Agent workdir/);
    await expect(
      readFile(path.join(outside, 'escaped.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a destination directory moved outside during the write', async () => {
    const { resolveAgentWorkspacePath, writeResolvedAgentWorkspaceFile } =
      await import('../workspace-paths');
    const parent = path.join(cwd, 'rename-race');
    const outside = path.join(root, 'rename-race-outside');
    const moved = path.join(outside, 'moved');
    await mkdir(parent, { recursive: true });
    await mkdir(outside, { recursive: true });
    const destination = await resolveAgentWorkspacePath(
      sessionId,
      'rename-race/escaped.bin',
    );
    const outcome = writeResolvedAgentWorkspaceFile(
      destination,
      new Uint8Array(25 * 1024 * 1024),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    let movedDirectory = false;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const names = await readdir(cwd).catch(() => []);
      if (names.some((name) => name.startsWith('.hatch-download-'))) {
        await rename(parent, moved);
        await symlink(moved, parent);
        movedDirectory = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(movedDirectory).toBe(true);
    await expect(outcome).resolves.toBeInstanceOf(Error);
    await expect(
      readFile(path.join(moved, 'escaped.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(cwd)).some((name) => name.startsWith('.hatch-download-')),
    ).toBe(false);
  });
});
