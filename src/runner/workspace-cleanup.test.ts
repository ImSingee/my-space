import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-session-cleanup-'));
process.env.HATCH_DATA_DIR = root;

const { AGENTS_DIR, agentHomeDir, agentSessionDir } =
  await import('~agent/paths');
const { listLocalWorkspaceSessionIds, removeSessionWorkspace } =
  await import('./workspace-cleanup');

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Runner conversation workspace cleanup', () => {
  it('discovers session directories without inspecting their contents', async () => {
    await mkdir(agentSessionDir('session-a'), { recursive: true });
    await mkdir(agentSessionDir('session-b'), { recursive: true });
    await writeFile(path.join(AGENTS_DIR, 'not-a-session'), 'file');
    await writeFile(
      path.join(agentSessionDir('session-a'), 'workspace-index.json'),
      '{not valid json',
    );

    await expect(listLocalWorkspaceSessionIds()).resolves.toEqual(
      expect.arrayContaining(['session-a', 'session-b']),
    );
  });

  it('removes the whole session and home while preserving other sessions', async () => {
    const target = agentSessionDir('session-delete');
    const neighbor = agentSessionDir('session-keep');
    await mkdir(path.join(target, 'work', 'anything', 'nested'), {
      recursive: true,
    });
    await writeFile(
      path.join(target, 'work', 'anything', 'nested', 'data'),
      'x',
    );
    await mkdir(agentHomeDir('session-delete'), { recursive: true });
    await mkdir(neighbor, { recursive: true });

    await removeSessionWorkspace('session-delete');

    await expect(exists(target)).resolves.toBe(false);
    await expect(exists(agentHomeDir('session-delete'))).resolves.toBe(false);
    await expect(exists(neighbor)).resolves.toBe(true);
  });

  it('rejects session ids that could escape the data root', async () => {
    await expect(removeSessionWorkspace('.')).rejects.toThrow(
      'Invalid session id.',
    );
    await expect(removeSessionWorkspace('../outside')).rejects.toThrow(
      'Invalid session id.',
    );
  });
});
