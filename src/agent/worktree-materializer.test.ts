import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
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
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorktreeMaterializer,
  WorktreeMaterializationError,
} from './worktree-materializer';

const run = promisify(execFile);
const tempRoots: string[] = [];
const originalDataDir = process.env.HATCH_DATA_DIR;
const testDataRoot = await mkdtemp(path.join(tmpdir(), 'hatch-mat-data-'));
await chmod(testDataRoot, 0o755);
process.env.HATCH_DATA_DIR = testDataRoot;
const [materializerModule, pathsModule, sandboxModule] = await Promise.all([
  import('./worktree-materializer'),
  import('./paths'),
  import('./shell-sandbox'),
]);
const { materializeWorktree } = materializerModule;
const { agentSessionDir, agentWorkDir } = pathsModule;
const { prepareAgentSessionSandbox, setAgentOwned } = sandboxModule;

async function tempRepo(agent = false): Promise<string> {
  const sessionId = agent ? `materializer-${randomUUID()}` : undefined;
  if (sessionId) prepareAgentSessionSandbox(sessionId);
  const parent = sessionId ? agentWorkDir(sessionId) : tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hatch-materializer-'));
  tempRoots.push(sessionId ? agentSessionDir(sessionId) : root);
  await run('git', ['init', '--initial-branch', 'master', root]);
  if (sessionId) setAgentOwned([root], sessionId);
  return root;
}

function generatedMaterializer(
  materialize = vi.fn<(root: string) => Promise<void>>(async (root) => {
    const target = path.join(root, '.hatch');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'generated.txt'), 'generated\n');
  }),
): WorktreeMaterializer {
  return {
    gitExcludePatterns: ['/.hatch/'],
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

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.HATCH_DATA_DIR;
  else process.env.HATCH_DATA_DIR = originalDataDir;
  await rm(testDataRoot, { recursive: true, force: true });
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
    expect(exclude.match(/^\/\.hatch\/$/gm)).toHaveLength(1);
    await expect(
      run('git', ['status', '--short'], { cwd: root }),
    ).resolves.toMatchObject({ stdout: '' });
    await expect(
      run('git', ['check-ignore', '-v', '.hatch/generated.txt'], {
        cwd: root,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('/.hatch/'),
    });
  });

  it('refuses a symlinked local exclude file before materializing', async () => {
    const root = await tempRepo(true);
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const outside = path.join(root, 'outside.txt');
    await Promise.all([rm(exclude), writeFile(outside, 'keep\n')]);
    await symlink(outside, exclude);
    const materialize = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(
      materializeWorktree(root, generatedMaterializer(materialize)),
    ).rejects.toThrow('.git/info/exclude must not be a symbolic link');
    await expect(readFile(outside, 'utf8')).resolves.toBe('keep\n');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('updates Agent worktree excludes idempotently through the sandbox helper', async () => {
    const root = await tempRepo(true);
    const materializer = generatedMaterializer();

    await materializeWorktree(root, materializer);
    await materializeWorktree(root, materializer);

    const exclude = await readFile(
      path.join(root, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude.match(/^\/\.hatch\/$/gm)).toHaveLength(1);
  });

  it('identifies materializer failures for contextual tool errors', async () => {
    const root = await tempRepo();
    const cause = new Error('SDK unavailable');

    await expect(
      materializeWorktree(
        root,
        generatedMaterializer(
          vi.fn<() => Promise<void>>(async () => {
            throw cause;
          }),
        ),
      ),
    ).rejects.toMatchObject({
      name: 'WorktreeMaterializationError',
      cause,
    } satisfies Partial<WorktreeMaterializationError>);
  });
});
