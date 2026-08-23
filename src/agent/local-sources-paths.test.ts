import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PlatformClient } from './platform-client';

const run = promisify(execFile);
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), 'hatch-source-paths-')),
);
// Per-session Linux UIDs need to traverse the fixture root to reach their
// private runner-data worktrees. Keep it non-listable and non-writable.
await chmod(root, 0o711);
process.env.HATCH_DATA_DIR = path.join(root, 'runner-data');

const {
  assertWorktreeAvailable,
  bundleWorktreeForDeploy,
  checkoutFromBundle,
  initNewWorktree,
} = await import('./local-sources');
const {
  AGENTS_DIR,
  agentAppWorkDir,
  agentHomeDir,
  agentSessionDir,
  agentWorkDir,
} = await import('./paths');
const {
  prepareAgentSessionSandbox,
  sandboxSpawn,
  setAgentOwned,
  wrapShellCommand,
} = await import('./shell-sandbox');
const { createAppTools } = await import('./tools/apps');
const { createWorkflowTools } = await import('./tools/workflows');

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function appSdkManifest(worktree: string): string {
  return path.join(worktree, '.hatch', 'sdk', '@hatch', 'data', 'package.json');
}

function appSdkImportMap(worktree: string): string {
  return path.join(worktree, '.hatch', 'import-map.json');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const relative = path.relative(AGENTS_DIR, cwd);
  const sessionId =
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
      ? relative.split(path.sep)[0]
      : undefined;
  const wrapped = sessionId
    ? sandboxSpawn(['git', ...args], sessionId)
    : { command: 'git', args };
  const result = await run(wrapped.command, wrapped.args, {
    cwd,
    env: sessionId
      ? {
          PATH: process.env.PATH,
          HOME: agentHomeDir(sessionId),
          LANG: process.env.LANG,
          GIT_TERMINAL_PROMPT: '0',
        }
      : undefined,
  });
  return result.stdout.trim();
}

async function commitFile(
  worktree: string,
  name = 'source.txt',
  content = 'source\n',
): Promise<string> {
  await writeFile(path.join(worktree, name), content);
  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-m', `add ${name}`);
  return git(worktree, 'rev-parse', 'HEAD');
}

function toolText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content.map((part) => part.text ?? '').join('');
}

function appDetail(id: string, slug = id) {
  return { id, slug } as NonNullable<
    Awaited<ReturnType<PlatformClient['getApp']>>
  >;
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runner source paths', () => {
  it.runIf(process.platform === 'linux' && process.getuid?.() === 0)(
    'keeps root-created scaffold and materialized files writable by the session',
    async () => {
      const sourceSession = 'linux-owner-source';
      const source = await initNewWorktree(
        sourceSession,
        'app',
        'linux-owner-source',
        async (worktree) => {
          await mkdir(path.join(worktree, 'scaffold', 'nested'), {
            recursive: true,
          });
          await writeFile(
            path.join(worktree, 'scaffold', 'nested', 'source.txt'),
            'root-created\n',
          );
        },
      );
      prepareAgentSessionSandbox(sourceSession);
      await run(
        '/bin/sh',
        [
          '-c',
          wrapShellCommand(
            'printf changed > scaffold/nested/source.txt && printf new > scaffold/nested/new.txt',
            sourceSession,
          ),
        ],
        { cwd: source.absolutePath },
      );
      await run(
        '/bin/sh',
        [
          '-c',
          wrapShellCommand(
            'git add -A && git commit -m scaffold >/dev/null',
            sourceSession,
          ),
        ],
        { cwd: source.absolutePath },
      );
      const { stdout: headOutput } = await run(
        '/bin/sh',
        ['-c', wrapShellCommand('git rev-parse HEAD', sourceSession)],
        { cwd: source.absolutePath },
      );
      const head = headOutput.trim();
      const bundle = await bundleWorktreeForDeploy(
        sourceSession,
        'app',
        'linux-owner-source',
        source.absolutePath,
      );

      const targetSession = 'linux-owner-target';
      const checkout = await checkoutFromBundle(
        targetSession,
        'app',
        {
          id: 'linux-owner-target',
          masterCommit: head,
          bundleBase64: bundle.bundleBase64,
        },
        {
          materializer: {
            async materialize(worktree) {
              await mkdir(path.join(worktree, 'generated', 'nested'), {
                recursive: true,
              });
              await writeFile(
                path.join(worktree, 'generated', 'nested', 'root.txt'),
                'root-created\n',
              );
            },
          },
        },
      );
      prepareAgentSessionSandbox(targetSession);
      const storedBundle = await lstat(
        path.join(
          agentSessionDir(targetSession),
          'bundles',
          'app-linux-owner-target.bundle',
        ),
      );
      expect(storedBundle.uid).toBe(0);
      expect(storedBundle.gid).toBe(0);
      expect(storedBundle.mode & 0o777).toBe(0o444);
      await run(
        '/bin/sh',
        [
          '-c',
          wrapShellCommand(
            'printf changed > generated/nested/root.txt && printf new > generated/nested/new.txt',
            targetSession,
          ),
        ],
        { cwd: checkout.absolutePath },
      );
      await expect(
        readFile(
          path.join(checkout.absolutePath, 'generated', 'nested', 'root.txt'),
          'utf8',
        ),
      ).resolves.toBe('changed');
      await expect(
        readFile(
          path.join(checkout.absolutePath, 'generated', 'nested', 'new.txt'),
          'utf8',
        ),
      ).resolves.toBe('new');
    },
  );

  it('rejects traversal, host absolute paths, and symlink escapes', async () => {
    const sessionId = 'path-escape';
    const work = agentWorkDir(sessionId);
    await mkdir(work, { recursive: true });

    await expect(
      assertWorktreeAvailable(sessionId, 'app', 'escape', '../outside'),
    ).rejects.toThrow(/inside the Agent workdir/);
    await expect(
      bundleWorktreeForDeploy(sessionId, 'app', 'escape', ''),
    ).rejects.toThrow('Workspace path is required.');
    await expect(
      bundleWorktreeForDeploy(sessionId, 'app', 'escape', '../outside'),
    ).rejects.toThrow(/inside the Agent workdir/);
    await expect(
      assertWorktreeAvailable(
        sessionId,
        'app',
        'escape',
        path.join(root, 'host-path'),
      ),
    ).rejects.toThrow(/inside the Agent workdir/);

    const outside = path.join(root, 'outside-target');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(work, 'link'));
    await expect(
      assertWorktreeAvailable(sessionId, 'app', 'escape', 'link/source'),
    ).rejects.toThrow(/escapes the Agent workdir through a symlink/);
  });

  it('rejects a worktree nested inside another Git checkout', async () => {
    const sessionId = 'path-overlap';
    const outer = await initNewWorktree(
      sessionId,
      'app',
      'outer-app',
      () => Promise.resolve(),
      'custom/outer',
    );
    const nested = path.join(outer.absolutePath, 'inner');

    await expect(
      initNewWorktree(
        sessionId,
        'workflow',
        'inner-workflow',
        () => Promise.resolve(),
        nested,
      ),
    ).rejects.toThrow(/nested inside another Git checkout/);
    await expect(exists(nested)).resolves.toBe(false);
  });

  it('serializes create preflight through local initialization', async () => {
    const sessionId = 'create-lock';
    let sequence = 0;
    const createApp = vi.fn<PlatformClient['createApp']>(async (input) => {
      sequence += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        id: `created-${sequence}`,
        slug: input.slug,
        name: input.name,
        files: [],
      };
    });
    const tools = createAppTools({
      sessionId,
      platform: { createApp } as unknown as PlatformClient,
      prepareWorktree: vi.fn<() => Promise<void>>(async () => undefined),
    });
    const create = tools.find((candidate) => candidate.name === 'create_app');
    if (!create) throw new Error('Missing create_app tool.');

    const results = await Promise.allSettled([
      create.execute('create-a', {
        slug: 'app-a',
        name: 'App A',
        target_path: 'custom/shared',
      }),
      create.execute('create-b', {
        slug: 'app-b',
        name: 'App B',
        target_path: 'custom/shared',
      }),
    ]);

    expect(createApp).toHaveBeenCalledOnce();
    expect(createApp).toHaveBeenCalledWith(
      { slug: 'app-a', name: 'App A' },
      sessionId,
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    await expect(
      readFile(
        appSdkManifest(path.join(agentWorkDir(sessionId), 'custom/shared')),
        'utf8',
      ),
    ).resolves.not.toContain('"version"');
    await expect(
      readFile(
        appSdkImportMap(path.join(agentWorkDir(sessionId), 'custom/shared')),
        'utf8',
      ),
    ).resolves.toContain('"@hatch/data"');
    const createdWorktree = path.join(agentWorkDir(sessionId), 'custom/shared');
    await expect(git(createdWorktree, 'status', '--short')).resolves.toBe('');
    await expect(
      exists(path.join(createdWorktree, '.gitignore')),
    ).resolves.toBe(false);
  });

  it('creates an app under apps/<slug> by default', async () => {
    const sessionId = 'create-default-slug';
    const createApp = vi.fn<PlatformClient['createApp']>(async (input) => ({
      id: 'immutable-app-id',
      slug: input.slug,
      name: input.name,
      files: [],
    }));
    const tools = createAppTools({
      sessionId,
      platform: { createApp } as unknown as PlatformClient,
      prepareWorktree: vi.fn<() => Promise<void>>(async () => undefined),
    });
    const create = tools.find((candidate) => candidate.name === 'create_app');
    if (!create) throw new Error('Missing create_app tool.');

    const result = await create.execute('create-default', {
      slug: 'human-slug',
      name: 'Human Slug',
    });

    expect(result.details).toMatchObject({
      id: 'immutable-app-id',
      path: 'apps/human-slug',
      absolutePath: agentAppWorkDir(sessionId, 'human-slug'),
    });
    expect(createApp).toHaveBeenCalledWith(
      { slug: 'human-slug', name: 'Human Slug' },
      sessionId,
    );
    await expect(
      git(
        agentAppWorkDir(sessionId, 'human-slug'),
        'remote',
        'get-url',
        'origin',
      ),
    ).resolves.toContain('app-immutable-app-id.bundle');
  });

  it('separates fresh app clones from existing checkout updates', async () => {
    const sessionId = 'checkout-app-modes';
    const getApp = vi.fn<PlatformClient['getApp']>(async () =>
      appDetail('immutable-app-id', 'human-slug'),
    );
    const getAppSource = vi.fn<PlatformClient['getAppSource']>(async () => ({
      id: 'immutable-app-id',
      masterCommit: null,
      bundleBase64: null,
    }));
    const associateSessionApp = vi.fn<PlatformClient['associateSessionApp']>(
      async () => ({ appId: 'immutable-app-id' }),
    );
    const tools = createAppTools({
      sessionId,
      platform: {
        associateSessionApp,
        getApp,
        getAppSource,
      } as unknown as PlatformClient,
      prepareWorktree: vi.fn<() => Promise<void>>(async () => undefined),
    });
    const checkout = tools.find((tool) => tool.name === 'checkout_app');
    if (!checkout) throw new Error('Missing checkout_app tool.');
    expect((checkout.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(['id', 'clone']),
    );

    await expect(
      checkout.execute('update-without-path', {
        id: 'immutable-app-id',
        clone: false,
      }),
    ).rejects.toThrow('source_path is required when clone is false');
    expect(getApp).not.toHaveBeenCalled();

    await expect(
      checkout.execute('update-with-force', {
        id: 'immutable-app-id',
        clone: false,
        source_path: 'custom/missing',
        force: true,
      }),
    ).rejects.toThrow('force is only valid when clone is true');
    expect(getAppSource).not.toHaveBeenCalled();

    await expect(
      checkout.execute('update-missing-path', {
        id: 'immutable-app-id',
        clone: false,
        source_path: 'custom/missing',
      }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      exists(path.join(agentWorkDir(sessionId), 'custom/missing')),
    ).resolves.toBe(false);
    expect(getApp).not.toHaveBeenCalled();

    const cloned = await checkout.execute('clone-default', {
      id: 'immutable-app-id',
      clone: true,
    });
    expect(cloned.details).toMatchObject({
      id: 'immutable-app-id',
      path: 'apps/human-slug',
      absolutePath: agentAppWorkDir(sessionId, 'human-slug'),
    });
    expect(getApp).toHaveBeenCalledOnce();
    expect(associateSessionApp).toHaveBeenCalledWith(
      sessionId,
      'immutable-app-id',
    );
    await expect(
      checkout.execute('clone-existing', {
        id: 'immutable-app-id',
        clone: true,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('associates deploy and rollback attempts before later failures', async () => {
    const sessionId = 'app-lifecycle-associations';
    const associateSessionApp = vi.fn<PlatformClient['associateSessionApp']>(
      async () => ({ appId: 'canonical-app' }),
    );
    const deployApp = vi.fn<PlatformClient['deployApp']>();
    const rollbackApp = vi
      .fn<PlatformClient['rollbackApp']>()
      .mockRejectedValue(new Error('rollback failed'));
    const tools = createAppTools({
      sessionId,
      platform: {
        associateSessionApp,
        deployApp,
        getApp: vi.fn<PlatformClient['getApp']>(async () => ({
          ...appDetail('canonical-app', 'mutable-slug'),
          createdAt: '2026-08-24T00:00:00.000Z',
        })),
        rollbackApp,
      } as unknown as PlatformClient,
    });
    const deploy = tools.find((tool) => tool.name === 'deploy_app');
    const rollback = tools.find((tool) => tool.name === 'rollback_app');
    if (!deploy || !rollback) throw new Error('Missing App lifecycle tools.');

    await expect(
      deploy.execute('deploy', {
        id: 'mutable-slug',
        source_path: 'custom/missing',
        message: 'Test association',
      }),
    ).rejects.toThrow(/not checked out/);
    expect(associateSessionApp).toHaveBeenCalledWith(
      sessionId,
      'canonical-app',
    );
    expect(deployApp).not.toHaveBeenCalled();

    associateSessionApp.mockClear();
    await expect(
      rollback.execute('rollback', { id: 'mutable-slug', version: 2 }),
    ).rejects.toThrow('rollback failed');
    expect(associateSessionApp).toHaveBeenCalledWith(sessionId, 'mutable-slug');
    expect(rollbackApp).toHaveBeenCalledWith('canonical-app', 2);
  });

  it('reports synchronized existing app and workflow checkouts', async () => {
    const sourceSessionId = 'checkout-tools-sync-source';
    const sourceWorktree = await initNewWorktree(
      sourceSessionId,
      'app',
      'source-repo',
      () => Promise.resolve(),
    );
    const masterCommit = await commitFile(sourceWorktree.absolutePath);
    const bundle = await bundleWorktreeForDeploy(
      sourceSessionId,
      'app',
      'source-repo',
      sourceWorktree.absolutePath,
    );
    const source = (id: string) => ({
      id,
      masterCommit,
      bundleBase64: bundle.bundleBase64,
    });
    const sessionId = 'checkout-tools-sync';
    const appTools = createAppTools({
      sessionId,
      platform: {
        associateSessionApp: vi.fn<PlatformClient['associateSessionApp']>(
          async () => ({ appId: 'app-id' }),
        ),
        getApp: vi.fn<PlatformClient['getApp']>(async () =>
          appDetail('app-id', 'app-slug'),
        ),
        getAppSource: vi.fn<PlatformClient['getAppSource']>(async () =>
          source('app-id'),
        ),
      } as unknown as PlatformClient,
      prepareWorktree: vi.fn<() => Promise<void>>(async () => {}),
    });
    const workflowTools = createWorkflowTools({
      sessionId,
      platform: {
        getWorkflowSource: vi.fn<PlatformClient['getWorkflowSource']>(
          async () => source('workflow-id'),
        ),
      } as unknown as PlatformClient,
    });
    const app = appTools.find((tool) => tool.name === 'checkout_app');
    const workflow = workflowTools.find(
      (tool) => tool.name === 'checkout_workflow',
    );
    if (!app || !workflow) throw new Error('Missing checkout tools.');

    const firstApp = await app.execute('app-first', {
      id: 'app-id',
      clone: true,
      source_path: 'custom/sync-app',
    });
    expect(toolText(firstApp)).not.toContain('lifecycle scripts');
    const appWorktree = path.join(agentWorkDir(sessionId), 'custom/sync-app');
    await expect(
      readFile(
        appSdkManifest(path.join(agentWorkDir(sessionId), 'custom/sync-app')),
        'utf8',
      ),
    ).resolves.toContain('"name": "@hatch/data"');
    await expect(
      readFile(appSdkImportMap(appWorktree), 'utf8'),
    ).resolves.toContain('"./sdk/@hatch/data/dist/data.js"');
    await expect(git(appWorktree, 'status', '--short')).resolves.toBe('');
    await expect(exists(path.join(appWorktree, '.gitignore'))).resolves.toBe(
      false,
    );
    const excludePath = path.join(appWorktree, '.git', 'info', 'exclude');
    const exclude = await readFile(excludePath, 'utf8');
    expect(exclude.match(/^\/\.hatch\/$/gm)).toHaveLength(1);
    expect(exclude.match(/^\/\.hatch-install-\*\/$/gm)).toHaveLength(1);
    expect(exclude.match(/^\/\.hatch-backup-\*\/$/gm)).toHaveLength(1);
    expect(exclude.match(/^\/node_modules\/$/gm)).toHaveLength(1);
    expect(exclude.match(/^\/gen\/$/gm)).toHaveLength(1);

    // Simulate a checkout materialized before Hatch installed its local rule.
    await writeFile(excludePath, exclude.replace('/.hatch/\n', ''));
    await expect(git(appWorktree, 'status', '--short')).resolves.toContain(
      '?? .hatch/',
    );
    const synchronizedApp = await app.execute('app-sync', {
      id: 'app-id',
      clone: false,
      source_path: 'custom/sync-app',
    });
    expect(toolText(synchronizedApp)).toContain(
      'Synchronized existing checkout',
    );
    expect(synchronizedApp.details).toMatchObject({
      replacedExisting: false,
      synchronizedExisting: true,
    });
    await expect(git(appWorktree, 'status', '--short')).resolves.toBe('');
    await expect(readFile(excludePath, 'utf8')).resolves.toContain(
      '/.hatch/\n',
    );

    await workflow.execute('workflow-first', {
      id: 'workflow-id',
      target_path: 'custom/sync-workflow',
    });
    await expect(
      exists(
        appSdkManifest(
          path.join(agentWorkDir(sessionId), 'custom/sync-workflow'),
        ),
      ),
    ).resolves.toBe(false);
    await expect(
      exists(
        appSdkImportMap(
          path.join(agentWorkDir(sessionId), 'custom/sync-workflow'),
        ),
      ),
    ).resolves.toBe(false);
    const synchronizedWorkflow = await workflow.execute('workflow-sync', {
      id: 'workflow-id',
      target_path: 'custom/sync-workflow',
    });
    expect(toolText(synchronizedWorkflow)).toContain(
      'Synchronized existing checkout',
    );
    expect(synchronizedWorkflow.details).toMatchObject({
      replacedExisting: false,
      synchronizedExisting: true,
    });
  }, 15_000);

  it('force replaces only the exact target and preserves unrelated checkout state', async () => {
    const sessionId = 'force-index-owner';
    const replaced = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      () => Promise.resolve(),
      'custom/shared',
    );
    const untouched = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      () => Promise.resolve(),
      'custom/other',
    );
    await commitFile(replaced.absolutePath, 'discard.txt', 'discard');
    await commitFile(untouched.absolutePath, 'keep.txt', 'keep');
    const sharedBundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'old-app',
      untouched.absolutePath,
    );
    const sharedBundlePath = path.join(
      agentSessionDir(sessionId),
      'bundles',
      'app-old-app.bundle',
    );
    await writeFile(
      sharedBundlePath,
      Buffer.from(sharedBundle.bundleBase64, 'base64'),
    );

    const workflow = await checkoutFromBundle(
      sessionId,
      'workflow',
      {
        id: 'new-workflow',
        masterCommit: null,
        bundleBase64: null,
      },
      { targetPath: 'custom/shared', force: true },
    );

    expect(workflow.replacedExisting).toBe(true);
    await expect(
      readFile(path.join(workflow.absolutePath, 'discard.txt'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      readFile(path.join(untouched.absolutePath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await expect(exists(sharedBundlePath)).resolves.toBe(true);
  });

  it('refuses to force replace a directory containing another checkout', async () => {
    const sessionId = 'force-nested-checkout';
    const nested = await initNewWorktree(
      sessionId,
      'app',
      'nested-app',
      () => Promise.resolve(),
      'custom/group/app-a',
    );
    await writeFile(path.join(nested.absolutePath, 'keep.txt'), 'keep');

    await expect(
      checkoutFromBundle(
        sessionId,
        'workflow',
        {
          id: 'replacement',
          masterCommit: null,
          bundleBase64: null,
        },
        { targetPath: 'custom/group', force: true, mode: 'clone' },
      ),
    ).rejects.toThrow(/contains the nested Git checkout.*custom\/group\/app-a/);
    await expect(
      readFile(path.join(nested.absolutePath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await expect(exists(path.join(nested.absolutePath, '.git'))).resolves.toBe(
      true,
    );
  });

  it('keeps an entity bundle when its checkout path is replaced', async () => {
    const sessionId = 'force-displaced-owner-bundle';
    const onlyCheckout = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      () => Promise.resolve(),
      'custom/shared',
    );
    await commitFile(onlyCheckout.absolutePath);
    const oldBundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'old-app',
      onlyCheckout.absolutePath,
    );
    const oldBundlePath = path.join(
      agentSessionDir(sessionId),
      'bundles',
      'app-old-app.bundle',
    );
    await writeFile(
      oldBundlePath,
      Buffer.from(oldBundle.bundleBase64, 'base64'),
    );

    await checkoutFromBundle(
      sessionId,
      'workflow',
      {
        id: 'new-workflow',
        masterCommit: null,
        bundleBase64: null,
      },
      { targetPath: onlyCheckout.absolutePath, force: true },
    );

    await expect(exists(oldBundlePath)).resolves.toBe(true);
  });

  it('completes force checkout when the old target needs permission repair for cleanup', async () => {
    const sessionId = 'force-cleanup-permissions';
    const target = path.join(agentWorkDir(sessionId), 'custom/locked');
    const lockedChild = path.join(target, 'child');
    await mkdir(lockedChild, { recursive: true });
    await writeFile(path.join(lockedChild, 'discard.txt'), 'discard');
    await chmod(lockedChild, 0o000);

    const checkout = await checkoutFromBundle(
      sessionId,
      'app',
      {
        id: 'replacement',
        masterCommit: null,
        bundleBase64: null,
      },
      { targetPath: target, force: true },
    );

    expect(checkout.absolutePath).toBe(target);
    expect(checkout.replacedExisting).toBe(true);
    await expect(readdir(agentSessionDir(sessionId))).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.checkout-/)]),
    );
  });

  it('treats files and dangling symlinks as occupied checkout targets', async () => {
    const sessionId = 'force-path-entry';
    const work = agentWorkDir(sessionId);
    await mkdir(path.join(work, 'custom'), { recursive: true });
    const fileTarget = path.join(work, 'custom/file-target');
    await writeFile(fileTarget, 'keep');
    const emptySource = {
      id: 'entry-app',
      masterCommit: null,
      bundleBase64: null,
    };

    await expect(
      checkoutFromBundle(sessionId, 'app', emptySource, {
        targetPath: fileTarget,
      }),
    ).rejects.toThrow(/already exists.*Nothing was changed/);
    await expect(readFile(fileTarget, 'utf8')).resolves.toBe('keep');
    await checkoutFromBundle(sessionId, 'app', emptySource, {
      targetPath: fileTarget,
      force: true,
    });
    expect((await lstat(fileTarget)).isDirectory()).toBe(true);

    const danglingTarget = path.join(work, 'custom/dangling-target');
    await symlink('missing-target', danglingTarget);
    await expect(
      checkoutFromBundle(
        sessionId,
        'workflow',
        { ...emptySource, id: 'entry-workflow' },
        { targetPath: danglingTarget },
      ),
    ).rejects.toThrow(/already exists.*Nothing was changed/);
    expect((await lstat(danglingTarget)).isSymbolicLink()).toBe(true);
    await checkoutFromBundle(
      sessionId,
      'workflow',
      { ...emptySource, id: 'entry-workflow' },
      { targetPath: danglingTarget, force: true },
    );
    expect((await lstat(danglingTarget)).isDirectory()).toBe(true);
  });

  it('preserves the old target when a forced checkout cannot be prepared', async () => {
    const sessionId = 'force-prepare-failure';
    const existing = await initNewWorktree(
      sessionId,
      'app',
      'existing-app',
      () => Promise.resolve(),
      'custom/replace-me',
    );
    await writeFile(path.join(existing.absolutePath, 'keep.txt'), 'keep');

    const source = await initNewWorktree(
      sessionId,
      'app',
      'source-app',
      () => Promise.resolve(),
      'custom/source',
    );
    await commitFile(source.absolutePath);
    const bundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'source-app',
      source.absolutePath,
    );

    await expect(
      checkoutFromBundle(
        sessionId,
        'workflow',
        {
          id: 'replacement',
          masterCommit: '0000000000000000000000000000000000000000',
          bundleBase64: bundle.bundleBase64,
        },
        { targetPath: existing.absolutePath, force: true },
      ),
    ).rejects.toThrow(/does not match platform master/);
    await expect(
      readFile(path.join(existing.absolutePath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
  });

  it('requires a matching origin, a clean worktree, and at least one commit', async () => {
    const sessionId = 'deploy-validation';
    const empty = await initNewWorktree(sessionId, 'app', 'empty-app', () =>
      Promise.resolve(),
    );
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'empty-app',
        empty.absolutePath,
      ),
    ).rejects.toThrow(/no commits yet/);

    const dirty = await initNewWorktree(sessionId, 'app', 'dirty-app', () =>
      Promise.resolve(),
    );
    await commitFile(dirty.absolutePath);
    await writeFile(path.join(dirty.absolutePath, 'source.txt'), 'dirty\n');
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'dirty-app',
        dirty.absolutePath,
      ),
    ).rejects.toThrow(/worktree is dirty/);

    const foreign = path.join(agentWorkDir(sessionId), 'foreign');
    await mkdir(foreign, { recursive: true });
    setAgentOwned([foreign], sessionId);
    await git(foreign, 'init', '--initial-branch', 'master');
    await git(foreign, 'config', 'user.name', 'Test');
    await git(foreign, 'config', 'user.email', 'test@example.test');
    await commitFile(foreign);
    await expect(
      bundleWorktreeForDeploy(sessionId, 'app', 'foreign-app', foreign),
    ).rejects.toThrow(/found no origin/);
    await git(foreign, 'remote', 'add', 'origin', path.join(root, 'other.git'));
    await expect(
      bundleWorktreeForDeploy(sessionId, 'app', 'foreign-app', foreign),
    ).rejects.toThrow(/expected origin/);
  });

  it('leaves legacy root worktrees in place and deploys them only by explicit path', async () => {
    const sessionId = 'legacy-layout';
    const legacy = await initNewWorktree(
      sessionId,
      'app',
      'legacy-app',
      () => Promise.resolve(),
      'legacy-app',
    );
    const head = await commitFile(legacy.absolutePath);

    expect(legacy.path).toBe('legacy-app');
    await expect(
      exists(agentAppWorkDir(sessionId, 'legacy-app')),
    ).resolves.toBe(false);
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'legacy-app',
        legacy.absolutePath,
      ),
    ).resolves.toMatchObject({ headCommit: head });
    expect(legacy.absolutePath).toBe(
      path.join(agentWorkDir(sessionId), 'legacy-app'),
    );
  });
});
