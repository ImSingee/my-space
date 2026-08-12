import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeWorktree,
  type WorktreeMaterializer,
} from './worktree-materializer';

const run = promisify(execFile);
const tempRoots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hatch-materializer-'));
  tempRoots.push(root);
  await run('git', ['init', '--initial-branch', 'master', root]);
  return root;
}

function generatedMaterializer(
  materialize = vi.fn<(root: string) => Promise<void>>(async (root) => {
    const target = path.join(root, 'node_modules', '@hatch');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'generated.txt'), 'generated\n');
  }),
): WorktreeMaterializer {
  return {
    gitExcludePatterns: ['/node_modules/@hatch/'],
    materialize,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('worktree materialization', () => {
  it('locally excludes generated files without changing App source', async () => {
    const root = await tempRepo();
    const materializer = generatedMaterializer();

    await materializeWorktree(root, materializer);
    await materializeWorktree(root, materializer);

    const exclude = await readFile(
      path.join(root, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude.match(/^\/node_modules\/@hatch\/$/gm)).toHaveLength(1);
    await expect(
      run('git', ['status', '--short'], { cwd: root }),
    ).resolves.toMatchObject({ stdout: '' });
    await expect(
      run('git', ['check-ignore', '-v', 'node_modules/@hatch/generated.txt'], {
        cwd: root,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('/node_modules/@hatch/'),
    });
  });

  it('refuses a symlinked local exclude file before materializing', async () => {
    const root = await tempRepo();
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const outside = path.join(root, 'outside.txt');
    await Promise.all([rm(exclude), writeFile(outside, 'keep\n')]);
    await symlink(outside, exclude);
    const materialize = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(
      materializeWorktree(root, generatedMaterializer(materialize)),
    ).rejects.toThrow('.git/info/exclude must be a regular file');
    await expect(readFile(outside, 'utf8')).resolves.toBe('keep\n');
    expect(materialize).not.toHaveBeenCalled();
  });
});
