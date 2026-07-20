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
const GENERATION = '2026-07-12T00:00:00.000Z';
const OLD_GENERATION = '2026-07-11T00:00:00.000Z';
const NEW_GENERATION = '2026-07-12T01:00:00.000Z';
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), 'hatch-source-paths-')),
);
process.env.HATCH_DATA_DIR = path.join(root, 'runner-data');

const {
  acquireSourceWorkspaceBarrier,
  assertWorktreeAvailable,
  bundleWorktreeForDeploy,
  checkoutFromBundle,
  initNewWorktree,
  removeSourceWorkspaces,
  withSourceWorkspaceLock,
} = await import('./local-sources');
const {
  AGENTS_DIR,
  agentAppWorkDir,
  agentSessionDir,
  agentWorkflowWorkDir,
  agentWorkspaceIndexPath,
  agentWorkDir,
} = await import('./paths');
const { listIndexedWorkspaces } = await import('./workspace-index');
const { createAppTools } = await import('./tools/apps');
const { createWorkflowTools } = await import('./tools/workflows');
const {
  inspectLocalWorkspaces,
  reconcileLocalWorkspaces,
  removeSessionWorkspace,
} = await import('../runner/workspace-cleanup');

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', args, { cwd });
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

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runner source paths', () => {
  it('uses separate defaults and supports relative and absolute custom paths', async () => {
    const sessionId = 'path-layout';
    const app = await initNewWorktree(
      sessionId,
      'app',
      'shared-id',
      GENERATION,
      () => Promise.resolve(),
    );
    const workflow = await initNewWorktree(
      sessionId,
      'workflow',
      'shared-id',
      GENERATION,
      () => Promise.resolve(),
    );
    expect(app.path).toBe('apps/shared-id');
    expect(app.absolutePath).toBe(agentAppWorkDir(sessionId, 'shared-id'));
    expect(workflow.path).toBe('workflows/shared-id');
    expect(workflow.absolutePath).toBe(
      agentWorkflowWorkDir(sessionId, 'shared-id'),
    );

    const custom = await initNewWorktree(
      sessionId,
      'app',
      'custom-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/primary',
    );
    const head = await commitFile(custom.absolutePath);
    const deploy = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'custom-app',
      GENERATION,
      'custom/primary',
    );
    expect(deploy.headCommit).toBe(head);

    const absoluteTarget = path.join(
      agentWorkDir(sessionId),
      'copies/absolute',
    );
    const copy = await checkoutFromBundle(
      sessionId,
      'app',
      {
        id: 'custom-app',
        generation: GENERATION,
        masterCommit: head,
        bundleBase64: deploy.bundleBase64,
      },
      { targetPath: absoluteTarget },
    );
    expect(copy.path).toBe('copies/absolute');
    expect(copy.absolutePath).toBe(absoluteTarget);
    await expect(
      readFile(path.join(copy.absolutePath, 'source.txt'), 'utf8'),
    ).resolves.toBe('source\n');

    expect(await listIndexedWorkspaces(sessionId)).toEqual(
      expect.arrayContaining([
        {
          kind: 'app',
          id: 'shared-id',
          generation: GENERATION,
          absolutePath: app.absolutePath,
        },
        {
          kind: 'workflow',
          id: 'shared-id',
          generation: GENERATION,
          absolutePath: workflow.absolutePath,
        },
        {
          kind: 'app',
          id: 'custom-app',
          generation: GENERATION,
          absolutePath: custom.absolutePath,
        },
        {
          kind: 'app',
          id: 'custom-app',
          generation: GENERATION,
          absolutePath: copy.absolutePath,
        },
      ]),
    );
  });

  it('rejects traversal, host absolute paths, and symlink escapes', async () => {
    const sessionId = 'path-escape';
    const work = agentWorkDir(sessionId);
    await mkdir(work, { recursive: true });

    await expect(
      assertWorktreeAvailable(sessionId, 'app', 'escape', '../outside'),
    ).rejects.toThrow(/inside the Agent workdir/);
    await expect(
      bundleWorktreeForDeploy(sessionId, 'app', 'escape', GENERATION, ''),
    ).rejects.toThrow('Workspace path is required.');
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'escape',
        GENERATION,
        '../outside',
      ),
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

  it('rejects a worktree nested inside another registered checkout', async () => {
    const sessionId = 'path-overlap';
    const outer = await initNewWorktree(
      sessionId,
      'app',
      'outer-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/outer',
    );
    const nested = path.join(outer.absolutePath, 'inner');

    await expect(
      initNewWorktree(
        sessionId,
        'workflow',
        'inner-workflow',
        GENERATION,
        () => Promise.resolve(),
        nested,
      ),
    ).rejects.toThrow(/overlaps the registered app/);
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
        generation: GENERATION,
        files: [],
      };
    });
    const tools = createAppTools({
      sessionId,
      platform: { createApp } as unknown as PlatformClient,
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
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
  });

  it('exposes force on app and workflow checkout tools', async () => {
    const sessionId = 'checkout-tools-force';
    const source = (id: string) => ({
      id,
      generation: GENERATION,
      masterCommit: null,
      bundleBase64: null,
    });
    const appTools = createAppTools({
      sessionId,
      platform: {
        getAppSource: vi.fn<PlatformClient['getAppSource']>(async () =>
          source('app-id'),
        ),
      } as unknown as PlatformClient,
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
      target_path: 'custom/app',
    });
    expect(toolText(firstApp)).toContain('Checked out "app-id"');
    await expect(
      app.execute('app-again', {
        id: 'app-id',
        target_path: 'custom/app',
        force: false,
      }),
    ).rejects.toThrow(/force: true/);
    const forcedApp = await app.execute('app-force', {
      id: 'app-id',
      target_path: 'custom/app',
      force: true,
    });
    expect(toolText(forcedApp)).toContain('Replaced existing checkout');

    await workflow.execute('workflow-first', {
      id: 'workflow-id',
      target_path: 'custom/workflow',
    });
    const forcedWorkflow = await workflow.execute('workflow-force', {
      id: 'workflow-id',
      target_path: 'custom/workflow',
      force: true,
    });
    expect(toolText(forcedWorkflow)).toContain('Replaced existing checkout');
  });

  it('reports synchronized existing app and workflow checkouts', async () => {
    const sourceSessionId = 'checkout-tools-sync-source';
    const sourceWorktree = await initNewWorktree(
      sourceSessionId,
      'app',
      'source-repo',
      GENERATION,
      () => Promise.resolve(),
    );
    const masterCommit = await commitFile(sourceWorktree.absolutePath);
    const bundle = await bundleWorktreeForDeploy(
      sourceSessionId,
      'app',
      'source-repo',
      GENERATION,
      sourceWorktree.absolutePath,
    );
    const source = (id: string) => ({
      id,
      generation: GENERATION,
      masterCommit,
      bundleBase64: bundle.bundleBase64,
    });
    const sessionId = 'checkout-tools-sync';
    const appTools = createAppTools({
      sessionId,
      platform: {
        getAppSource: vi.fn<PlatformClient['getAppSource']>(async () =>
          source('app-id'),
        ),
      } as unknown as PlatformClient,
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

    await app.execute('app-first', {
      id: 'app-id',
      target_path: 'custom/sync-app',
    });
    const synchronizedApp = await app.execute('app-sync', {
      id: 'app-id',
      target_path: 'custom/sync-app',
    });
    expect(toolText(synchronizedApp)).toContain(
      'Synchronized existing checkout',
    );
    expect(synchronizedApp.details).toMatchObject({
      replacedExisting: false,
      synchronizedExisting: true,
    });

    await workflow.execute('workflow-first', {
      id: 'workflow-id',
      target_path: 'custom/sync-workflow',
    });
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
  });

  it('force replaces one exact indexed target without touching other checkouts', async () => {
    const sessionId = 'force-index-owner';
    const replaced = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/shared',
    );
    const untouched = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/other',
    );
    await commitFile(replaced.absolutePath, 'discard.txt', 'discard');
    await commitFile(untouched.absolutePath, 'keep.txt', 'keep');
    const sharedBundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'old-app',
      GENERATION,
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
        generation: NEW_GENERATION,
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
    expect(await listIndexedWorkspaces(sessionId)).toEqual(
      expect.arrayContaining([
        {
          kind: 'app',
          id: 'old-app',
          generation: GENERATION,
          absolutePath: untouched.absolutePath,
        },
        {
          kind: 'workflow',
          id: 'new-workflow',
          generation: NEW_GENERATION,
          absolutePath: workflow.absolutePath,
        },
      ]),
    );
    expect(await listIndexedWorkspaces(sessionId)).not.toContainEqual(
      expect.objectContaining({
        kind: 'app',
        absolutePath: replaced.absolutePath,
      }),
    );
  });

  it('removes the displaced owner bundle only after its last checkout is replaced', async () => {
    const sessionId = 'force-displaced-owner-bundle';
    const onlyCheckout = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/shared',
    );
    await commitFile(onlyCheckout.absolutePath);
    const oldBundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'old-app',
      GENERATION,
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
        generation: NEW_GENERATION,
        masterCommit: null,
        bundleBase64: null,
      },
      { targetPath: onlyCheckout.absolutePath, force: true },
    );

    await expect(exists(oldBundlePath)).resolves.toBe(false);
  });

  it('keeps the displaced owner bundle for an unindexed default checkout', async () => {
    const sessionId = 'force-unindexed-default-bundle';
    const defaultCheckout = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      () => Promise.resolve(),
    );
    const replacedCheckout = await initNewWorktree(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/shared',
    );
    await commitFile(defaultCheckout.absolutePath, 'keep.txt', 'keep');
    const oldBundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'old-app',
      GENERATION,
      defaultCheckout.absolutePath,
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
    await writeFile(
      agentWorkspaceIndexPath(sessionId),
      JSON.stringify({
        entries: (await listIndexedWorkspaces(sessionId)).filter(
          (entry) =>
            path.resolve(entry.absolutePath) ===
            path.resolve(replacedCheckout.absolutePath),
        ),
      }),
    );

    await checkoutFromBundle(
      sessionId,
      'workflow',
      {
        id: 'new-workflow',
        generation: NEW_GENERATION,
        masterCommit: null,
        bundleBase64: null,
      },
      { targetPath: replacedCheckout.absolutePath, force: true },
    );

    await expect(exists(oldBundlePath)).resolves.toBe(true);
    await expect(
      readFile(path.join(defaultCheckout.absolutePath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await expect(
      git(defaultCheckout.absolutePath, 'fetch', 'origin', 'master'),
    ).resolves.toBe('');
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
        generation: GENERATION,
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
      generation: GENERATION,
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
      GENERATION,
      () => Promise.resolve(),
      'custom/replace-me',
    );
    await writeFile(path.join(existing.absolutePath, 'keep.txt'), 'keep');

    const source = await initNewWorktree(
      sessionId,
      'app',
      'source-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/source',
    );
    await commitFile(source.absolutePath);
    const bundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'source-app',
      GENERATION,
      source.absolutePath,
    );

    await expect(
      checkoutFromBundle(
        sessionId,
        'workflow',
        {
          id: 'replacement',
          generation: NEW_GENERATION,
          masterCommit: '0000000000000000000000000000000000000000',
          bundleBase64: bundle.bundleBase64,
        },
        { targetPath: existing.absolutePath, force: true },
      ),
    ).rejects.toThrow(/does not match platform master/);
    await expect(
      readFile(path.join(existing.absolutePath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep');
    await expect(listIndexedWorkspaces(sessionId)).resolves.toContainEqual({
      kind: 'app',
      id: 'existing-app',
      generation: GENERATION,
      absolutePath: existing.absolutePath,
    });
  });

  it('requires a matching origin, a clean worktree, and at least one commit', async () => {
    const sessionId = 'deploy-validation';
    const empty = await initNewWorktree(
      sessionId,
      'app',
      'empty-app',
      GENERATION,
      () => Promise.resolve(),
    );
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'empty-app',
        GENERATION,
        empty.absolutePath,
      ),
    ).rejects.toThrow(/no commits yet/);

    const dirty = await initNewWorktree(
      sessionId,
      'app',
      'dirty-app',
      GENERATION,
      () => Promise.resolve(),
    );
    await commitFile(dirty.absolutePath);
    await writeFile(path.join(dirty.absolutePath, 'source.txt'), 'dirty\n');
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'dirty-app',
        GENERATION,
        dirty.absolutePath,
      ),
    ).rejects.toThrow(/worktree is dirty/);

    const foreign = path.join(agentWorkDir(sessionId), 'foreign');
    await mkdir(foreign, { recursive: true });
    await git(foreign, 'init', '--initial-branch', 'master');
    await git(foreign, 'config', 'user.name', 'Test');
    await git(foreign, 'config', 'user.email', 'test@example.test');
    await commitFile(foreign);
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'foreign-app',
        GENERATION,
        foreign,
      ),
    ).rejects.toThrow(/found no origin/);
    await git(foreign, 'remote', 'add', 'origin', path.join(root, 'other.git'));
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'app',
        'foreign-app',
        GENERATION,
        foreign,
      ),
    ).rejects.toThrow(/expected origin/);
  });

  it('leaves legacy root worktrees in place and deploys them only by explicit path', async () => {
    const sessionId = 'legacy-layout';
    const legacy = await initNewWorktree(
      sessionId,
      'app',
      'legacy-app',
      GENERATION,
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
        GENERATION,
        legacy.absolutePath,
      ),
    ).resolves.toMatchObject({ headCommit: head });
    expect(legacy.absolutePath).toBe(
      path.join(agentWorkDir(sessionId), 'legacy-app'),
    );
  });
});

describe('runner workspace cleanup', () => {
  it('rejects a session segment that resolves to the Agent root', async () => {
    await expect(removeSessionWorkspace('.')).rejects.toThrow(
      'Invalid session id.',
    );
  });

  it('rejects unsafe ids from a modified workspace index', async () => {
    const sessionId = 'unsafe-index';
    const victim = path.join(
      AGENTS_DIR,
      'other-session',
      'bundles',
      'app-real.bundle',
    );
    await mkdir(path.dirname(victim), { recursive: true });
    await writeFile(victim, 'keep');
    await mkdir(agentWorkDir(sessionId), { recursive: true });
    const unsafeId = 'x/../../../other-session/bundles/app-real';
    await writeFile(
      agentWorkspaceIndexPath(sessionId),
      JSON.stringify({
        entries: [
          {
            kind: 'app',
            id: unsafeId,
            absolutePath: path.join(agentWorkDir(sessionId), 'unused'),
          },
        ],
      }),
    );

    await expect(listIndexedWorkspaces(sessionId)).resolves.toEqual([]);
    await expect(
      removeSourceWorkspaces(sessionId, 'app', unsafeId, GENERATION),
    ).rejects.toThrow('Invalid app id.');
    await expect(readFile(victim, 'utf8')).resolves.toBe('keep');
  });

  it('persists indexed generations and keeps them in the hello snapshot', async () => {
    const sessionId = 'generation-index';
    const indexed = await initNewWorktree(
      sessionId,
      'app',
      'indexed-app',
      GENERATION,
      () => Promise.resolve(),
    );
    await mkdir(agentWorkflowWorkDir(sessionId, 'unindexed-workflow'), {
      recursive: true,
    });

    const stored = JSON.parse(
      await readFile(agentWorkspaceIndexPath(sessionId), 'utf8'),
    ) as { entries: unknown[] };
    expect(stored.entries).toContainEqual({
      kind: 'app',
      id: 'indexed-app',
      generation: GENERATION,
      absolutePath: indexed.absolutePath,
    });

    const snapshot = await inspectLocalWorkspaces();
    const sources = snapshot.sources.filter(
      (source) => source.sessionId === sessionId,
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        {
          sessionId,
          kind: 'app',
          id: 'indexed-app',
          generation: GENERATION,
        },
        {
          sessionId,
          kind: 'workflow',
          id: 'unindexed-workflow',
          generation: null,
        },
      ]),
    );
    expect(sources).not.toContainEqual({
      sessionId,
      kind: 'app',
      id: 'indexed-app',
      generation: null,
    });

    await writeFile(
      agentWorkspaceIndexPath(sessionId),
      JSON.stringify({
        entries: [
          {
            kind: 'app',
            id: 'indexed-app',
            absolutePath: indexed.absolutePath,
          },
        ],
      }),
    );
    await expect(listIndexedWorkspaces(sessionId)).resolves.toEqual([]);
  });

  it('removes all indexed paths for one entity without touching the other kind', async () => {
    const sessionId = 'entity-cleanup';
    const app = await initNewWorktree(
      sessionId,
      'app',
      'same-id',
      GENERATION,
      () => Promise.resolve(),
    );
    const head = await commitFile(app.absolutePath);
    const bundle = await bundleWorktreeForDeploy(
      sessionId,
      'app',
      'same-id',
      GENERATION,
      app.absolutePath,
    );
    const custom = await checkoutFromBundle(
      sessionId,
      'app',
      {
        id: 'same-id',
        generation: GENERATION,
        masterCommit: head,
        bundleBase64: bundle.bundleBase64,
      },
      { targetPath: 'custom/same-id' },
    );
    const workflow = await initNewWorktree(
      sessionId,
      'workflow',
      'same-id',
      GENERATION,
      () => Promise.resolve(),
    );

    await expect(
      removeSourceWorkspaces(sessionId, 'app', 'same-id', GENERATION),
    ).resolves.toBe(2);
    await expect(exists(app.absolutePath)).resolves.toBe(false);
    await expect(exists(custom.absolutePath)).resolves.toBe(false);
    await expect(exists(workflow.absolutePath)).resolves.toBe(true);
    expect(await listIndexedWorkspaces(sessionId)).toEqual([
      {
        kind: 'workflow',
        id: 'same-id',
        generation: GENERATION,
        absolutePath: workflow.absolutePath,
      },
    ]);
  });

  it('preserves a nested checkout recorded by an older overlapping index', async () => {
    const sessionId = 'overlap-cleanup';
    const outer = await initNewWorktree(
      sessionId,
      'app',
      'outer-app',
      GENERATION,
      () => Promise.resolve(),
      'custom/outer',
    );
    await writeFile(path.join(outer.absolutePath, 'outer.txt'), 'outer');
    const inner = path.join(outer.absolutePath, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(inner, 'keep.txt'), 'inner');
    await writeFile(
      agentWorkspaceIndexPath(sessionId),
      JSON.stringify({
        entries: [
          {
            kind: 'app',
            id: 'outer-app',
            generation: GENERATION,
            absolutePath: outer.absolutePath,
          },
          {
            kind: 'workflow',
            id: 'inner-workflow',
            generation: GENERATION,
            absolutePath: inner,
          },
        ],
      }),
    );

    await expect(
      removeSourceWorkspaces(sessionId, 'app', 'outer-app', GENERATION),
    ).resolves.toBe(1);
    await expect(exists(path.join(outer.absolutePath, '.git'))).resolves.toBe(
      false,
    );
    await expect(
      exists(path.join(outer.absolutePath, 'outer.txt')),
    ).resolves.toBe(false);
    await expect(readFile(path.join(inner, 'keep.txt'), 'utf8')).resolves.toBe(
      'inner',
    );
    expect(await listIndexedWorkspaces(sessionId)).toEqual([
      {
        kind: 'workflow',
        id: 'inner-workflow',
        generation: GENERATION,
        absolutePath: inner,
      },
    ]);
  });

  it('preserves a replacement checkout and bundle after delayed old-generation cleanup', async () => {
    const sessionId = 'delayed-generation-cleanup';
    const old = await initNewWorktree(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      () => Promise.resolve(),
    );
    const head = await commitFile(old.absolutePath);
    const deploy = await bundleWorktreeForDeploy(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      old.absolutePath,
    );
    await removeSourceWorkspaces(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
    );

    const replacement = await checkoutFromBundle(sessionId, 'workflow', {
      id: 'reused-id',
      generation: NEW_GENERATION,
      masterCommit: head,
      bundleBase64: deploy.bundleBase64,
    });
    const bundle = path.join(
      agentSessionDir(sessionId),
      'bundles',
      'workflow-reused-id.bundle',
    );

    await expect(
      removeSourceWorkspaces(
        sessionId,
        'workflow',
        'reused-id',
        OLD_GENERATION,
      ),
    ).resolves.toBe(0);
    await expect(exists(replacement.absolutePath)).resolves.toBe(true);
    await expect(readFile(bundle)).resolves.not.toHaveLength(0);
    await expect(listIndexedWorkspaces(sessionId)).resolves.toContainEqual({
      kind: 'workflow',
      id: 'reused-id',
      generation: NEW_GENERATION,
      absolutePath: replacement.absolutePath,
    });
  });

  it('drops an old shared bundle when a reused id is created again', async () => {
    const sessionId = 'reused-generation-create';
    const old = await initNewWorktree(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      () => Promise.resolve(),
      'custom/old',
    );
    await commitFile(old.absolutePath);
    const deploy = await bundleWorktreeForDeploy(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      old.absolutePath,
    );
    const bundle = path.join(
      agentSessionDir(sessionId),
      'bundles',
      'workflow-reused-id.bundle',
    );
    await writeFile(bundle, Buffer.from(deploy.bundleBase64, 'base64'));

    await initNewWorktree(
      sessionId,
      'workflow',
      'reused-id',
      NEW_GENERATION,
      () => Promise.resolve(),
      'custom/replacement',
    );

    await expect(exists(bundle)).resolves.toBe(false);
    await expect(exists(old.absolutePath)).resolves.toBe(true);
  });

  it('does not deploy an indexed checkout from an older entity generation', async () => {
    const sessionId = 'stale-generation-deploy';
    const old = await initNewWorktree(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      () => Promise.resolve(),
    );
    await commitFile(old.absolutePath);

    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'workflow',
        'reused-id',
        NEW_GENERATION,
        old.absolutePath,
      ),
    ).rejects.toThrow(/previous incarnation/);

    await reconcileLocalWorkspaces({
      staleSessionIds: [],
      staleSources: [
        {
          sessionId,
          kind: 'workflow',
          id: 'reused-id',
          generation: OLD_GENERATION,
        },
      ],
    });
    await expect(exists(old.absolutePath)).resolves.toBe(false);
    await expect(
      bundleWorktreeForDeploy(
        sessionId,
        'workflow',
        'reused-id',
        NEW_GENERATION,
        old.absolutePath,
      ),
    ).rejects.toThrow(/not checked out/);
  });

  it('reconciles stale sessions and deleted default entities after reconnect', async () => {
    const staleSession = 'stale-session';
    const activeSession = 'active-session';
    await mkdir(agentWorkDir(staleSession), { recursive: true });
    const staleApp = await initNewWorktree(
      activeSession,
      'app',
      'deleted-app',
      GENERATION,
      () => Promise.resolve(),
    );
    const currentWorkflow = await initNewWorktree(
      activeSession,
      'workflow',
      'current-workflow',
      GENERATION,
      () => Promise.resolve(),
    );

    await reconcileLocalWorkspaces({
      staleSessionIds: [staleSession],
      staleSources: [
        {
          sessionId: activeSession,
          kind: 'app',
          id: 'deleted-app',
          generation: GENERATION,
        },
      ],
    });

    await expect(exists(agentSessionDir(staleSession))).resolves.toBe(false);
    await expect(exists(staleApp.absolutePath)).resolves.toBe(false);
    await expect(exists(currentWorkflow.absolutePath)).resolves.toBe(true);
    await removeSessionWorkspace(activeSession);
    await expect(exists(agentSessionDir(activeSession))).resolves.toBe(false);
  });

  it('ignores non-entity grouping directories in the hello snapshot', async () => {
    const sessionId = 'grouping-directory';
    const nested = await initNewWorktree(
      sessionId,
      'app',
      'nested-app',
      GENERATION,
      () => Promise.resolve(),
      'apps/team_one/nested-app',
    );

    const snapshot = await inspectLocalWorkspaces();
    expect(snapshot.sources).toContainEqual({
      sessionId,
      kind: 'app',
      id: 'nested-app',
      generation: GENERATION,
    });
    expect(snapshot.sources).not.toContainEqual({
      sessionId,
      kind: 'app',
      id: 'team_one',
      generation: null,
    });
    await expect(
      reconcileLocalWorkspaces({ staleSessionIds: [], staleSources: [] }),
    ).resolves.toBeUndefined();
    await expect(exists(nested.absolutePath)).resolves.toBe(true);
  });

  it('blocks a replacement checkout until stale snapshot cleanup completes', async () => {
    const sessionId = 'reused-workflow-barrier';
    const old = await initNewWorktree(
      sessionId,
      'workflow',
      'reused-id',
      OLD_GENERATION,
      () => Promise.resolve(),
    );
    const barrier = await acquireSourceWorkspaceBarrier();
    try {
      const snapshot = await inspectLocalWorkspaces();
      const staleSources = snapshot.sources.filter(
        (source) => source.sessionId === sessionId && source.id === 'reused-id',
      );
      await rm(old.absolutePath, { recursive: true, force: true });
      let replacementStarted = false;
      const replacement = withSourceWorkspaceLock(sessionId, async () => {
        replacementStarted = true;
        return checkoutFromBundle(sessionId, 'workflow', {
          id: 'reused-id',
          generation: NEW_GENERATION,
          masterCommit: null,
          bundleBase64: null,
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(replacementStarted).toBe(false);
      await reconcileLocalWorkspaces(
        { staleSessionIds: [], staleSources },
        barrier,
      );
      barrier.release();

      const current = await replacement;
      expect(replacementStarted).toBe(true);
      await expect(exists(current.absolutePath)).resolves.toBe(true);
    } finally {
      barrier.release();
    }
  });

  it('cancels a source mutation waiting behind the reconnect barrier', async () => {
    const barrier = await acquireSourceWorkspaceBarrier();
    try {
      const controller = new AbortController();
      let started = false;
      const waiting = withSourceWorkspaceLock(
        'cancelled-source-operation',
        () => {
          started = true;
          return Promise.resolve();
        },
        controller.signal,
      );
      controller.abort();

      await expect(waiting).rejects.toThrow(/aborted/);
      expect(started).toBe(false);
    } finally {
      barrier.release();
    }
  });
});
