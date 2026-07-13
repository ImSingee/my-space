/**
 * Full platform <-> runner source transfer round-trip over git bundles:
 *
 *   platform exportMasterBundle -> runner checkoutFromBundle -> agent
 *   commits -> runner bundleWorktreeForDeploy -> platform stageBundleCheckout
 *   -> publishDeploymentSource (fast-forward master).
 *
 * Everything runs against throwaway temp dirs; HATCH_DATA_DIR is pointed at a
 * temp root before the modules under test are imported (their path constants
 * bind at import time).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = await mkdtemp(path.join(tmpdir(), 'hatch-bundle-rt-'));
const GENERATION = '2026-07-12T00:00:00.000Z';
const NEXT_GENERATION = '2026-07-12T01:00:00.000Z';
process.env.HATCH_DATA_DIR = path.join(root, 'runner-data');

// Import after HATCH_DATA_DIR is set (module-level path constants).
const { bundleWorktreeForDeploy, checkoutFromBundle, initNewWorktree } =
  await import('~agent/local-sources');
const { createGitSource } = await import('~server/source-git');

const platform = createGitSource({
  noun: 'app',
  deployTool: 'deploy_app',
  repoDir: (id) => path.join(root, 'repos', `${id}.git`),
  deployCheckoutDir: (id) => path.join(root, 'checkouts', id),
  agentCheckoutDir: (sessionId, id) =>
    path.join(root, 'server-agents', sessionId, id),
});

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} failed: ${err || out}`));
    });
  });
}

const git = (args: string[], cwd: string) => run('git', args, cwd);

async function commitAll(worktree: string, message: string): Promise<string> {
  await git(['add', '-A'], worktree);
  await git(['commit', '-m', message], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('git bundle round-trip (platform <-> runner)', () => {
  const APP_ID = 'rt-app';
  const SESSION = 'rt-session';

  it('transfers source both ways and fast-forwards canonical master', async () => {
    // -- Seed the canonical repo with an initial commit (platform side). ----
    const seed = path.join(root, 'seed');
    await mkdir(seed, { recursive: true });
    await git(['init', '--initial-branch', 'master'], seed);
    await git(['config', 'user.email', 't@t'], seed);
    await git(['config', 'user.name', 't'], seed);
    await writeFile(path.join(seed, 'README.md'), 'v1\n');
    const seedCommit = await commitAll(seed, 'seed v1');
    await platform.publishDeploymentSource(APP_ID, seed, 1);
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(seedCommit);

    // -- Platform -> runner: export master, sync a local checkout. ----------
    const exported = await platform.exportMasterBundle(APP_ID);
    expect(exported).not.toBeNull();
    const checkout = await checkoutFromBundle(SESSION, 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: seedCommit,
      bundleBase64: exported!.toString('base64'),
    });
    expect(checkout.headCommit).toBe(seedCommit);
    expect(checkout.dirty).toBe(false);
    await expect(
      readFile(path.join(checkout.absolutePath, 'README.md'), 'utf8'),
    ).resolves.toBe('v1\n');

    // -- Agent work: edit + commit in the runner worktree. ------------------
    await writeFile(path.join(checkout.absolutePath, 'README.md'), 'v2\n');
    const localCommit = await commitAll(checkout.absolutePath, 'agent edit');

    // -- Runner -> platform: bundle the worktree, stage it, publish. --------
    const deploy = await bundleWorktreeForDeploy(
      SESSION,
      'app',
      APP_ID,
      GENERATION,
      checkout.absolutePath,
    );
    expect(deploy.headCommit).toBe(localCommit);

    const staged = await platform.stageBundleCheckout(
      APP_ID,
      Buffer.from(deploy.bundleBase64, 'base64'),
    );
    try {
      await expect(
        readFile(path.join(staged.dir, 'README.md'), 'utf8'),
      ).resolves.toBe('v2\n');
      const published = await platform.publishDeploymentSource(
        APP_ID,
        staged.dir,
        2,
      );
      expect(published.commit).toBe(localCommit);
    } finally {
      await staged.cleanup();
    }
    await expect(platform.masterCommit(APP_ID)).resolves.toBe(localCommit);
  });

  it('rejects an existing checkout after refreshing its origin bundle', async () => {
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const worktree = path.join(
      process.env.HATCH_DATA_DIR!,
      'agents',
      SESSION,
      'work',
      'apps',
      APP_ID,
    );
    const head = await git(['rev-parse', 'HEAD'], worktree);
    const contents = await readFile(path.join(worktree, 'README.md'), 'utf8');

    await expect(
      checkoutFromBundle(SESSION, 'app', {
        id: APP_ID,
        generation: GENERATION,
        masterCommit: master,
        bundleBase64: exported!.toString('base64'),
      }),
    ).rejects.toThrow(/already exists.*origin bundle was refreshed/);
    await expect(git(['rev-parse', 'HEAD'], worktree)).resolves.toBe(head);
    await expect(
      readFile(path.join(worktree, 'README.md'), 'utf8'),
    ).resolves.toBe(contents);
    await git(['fetch', 'origin', 'master'], worktree);
    const originMaster = await git(['rev-parse', 'origin/master'], worktree);
    expect(originMaster).toBe(master);
  });

  it('rejects a stale bundle that is not a fast-forward of master', async () => {
    // A second session syncs, commits on top of v2… ------------------------
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const stale = await checkoutFromBundle('rt-stale', 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: master,
      bundleBase64: exported!.toString('base64'),
    });
    await writeFile(path.join(stale.absolutePath, 'README.md'), 'stale\n');
    await commitAll(stale.absolutePath, 'stale edit');
    const staleBundle = await bundleWorktreeForDeploy(
      'rt-stale',
      'app',
      APP_ID,
      GENERATION,
      stale.absolutePath,
    );

    // …but master advances first (another deploy wins the race). ------------
    const winner = await checkoutFromBundle('rt-winner', 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: master,
      bundleBase64: exported!.toString('base64'),
    });
    await writeFile(path.join(winner.absolutePath, 'README.md'), 'winner\n');
    await commitAll(winner.absolutePath, 'winner edit');
    const winnerBundle = await bundleWorktreeForDeploy(
      'rt-winner',
      'app',
      APP_ID,
      GENERATION,
      winner.absolutePath,
    );
    const stagedWinner = await platform.stageBundleCheckout(
      APP_ID,
      Buffer.from(winnerBundle.bundleBase64, 'base64'),
    );
    try {
      await platform.publishDeploymentSource(APP_ID, stagedWinner.dir, 3);
    } finally {
      await stagedWinner.cleanup();
    }

    // The stale bundle still stages (self-contained history) but the deploy
    // pipeline's fast-forward check rejects it, same as worktree deploys.
    const stagedStale = await platform.stageBundleCheckout(
      APP_ID,
      Buffer.from(staleBundle.bundleBase64, 'base64'),
    );
    try {
      await expect(
        platform.publishDeploymentSource(APP_ID, stagedStale.dir, 4),
      ).rejects.toThrow(/master advanced/);
    } finally {
      await stagedStale.cleanup();
    }
  });

  it('requires force to replace a previous generation with an empty repo', async () => {
    const sessionId = 'rt-recreated';
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const old = await checkoutFromBundle(sessionId, 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: master,
      bundleBase64: exported!.toString('base64'),
    });

    await expect(
      checkoutFromBundle(sessionId, 'app', {
        id: APP_ID,
        generation: NEXT_GENERATION,
        masterCommit: null,
        bundleBase64: null,
      }),
    ).rejects.toThrow(/already exists.*Nothing was changed/);

    const replacement = await checkoutFromBundle(
      sessionId,
      'app',
      {
        id: APP_ID,
        generation: NEXT_GENERATION,
        masterCommit: null,
        bundleBase64: null,
      },
      { force: true },
    );
    expect(replacement.replacedExisting).toBe(true);
    expect(replacement.headCommit).toBeNull();
    await expect(
      readFile(path.join(old.absolutePath, 'README.md'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });

  it('requires force to discard local-only work against an empty remote', async () => {
    const fresh = await initNewWorktree(
      'rt-fresh',
      'app',
      'new-app',
      GENERATION,
      () => Promise.resolve(),
    );
    await writeFile(path.join(fresh.absolutePath, 'a.txt'), 'work\n');
    const localCommit = await commitAll(fresh.absolutePath, 'local work');
    await expect(
      checkoutFromBundle('rt-fresh', 'app', {
        id: 'new-app',
        generation: GENERATION,
        masterCommit: null,
        bundleBase64: null,
      }),
    ).rejects.toThrow(/already exists.*platform master is currently empty/);
    await expect(git(['rev-parse', 'HEAD'], fresh.absolutePath)).resolves.toBe(
      localCommit,
    );

    const again = await checkoutFromBundle(
      'rt-fresh',
      'app',
      {
        id: 'new-app',
        generation: GENERATION,
        masterCommit: null,
        bundleBase64: null,
      },
      { force: true },
    );
    expect(again.replacedExisting).toBe(true);
    expect(again.headCommit).toBeNull();
    await expect(
      readFile(path.join(again.absolutePath, 'a.txt'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });

  it('materializes the first remote commit only when force is requested', async () => {
    const sessionId = 'rt-empty-then-source';
    const empty = await checkoutFromBundle(sessionId, 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: null,
      bundleBase64: null,
    });
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const source = {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: master,
      bundleBase64: exported!.toString('base64'),
    };

    await expect(checkoutFromBundle(sessionId, 'app', source)).rejects.toThrow(
      /already exists.*origin bundle was refreshed/,
    );
    expect(
      await git(['rev-parse', '--verify', 'HEAD'], empty.absolutePath).catch(
        () => '',
      ),
    ).toBe('');

    const replacement = await checkoutFromBundle(sessionId, 'app', source, {
      force: true,
    });
    expect(replacement.replacedExisting).toBe(true);
    expect(replacement.headCommit).toBe(master);
    await expect(
      readFile(path.join(replacement.absolutePath, 'README.md'), 'utf8'),
    ).resolves.not.toBe('');
  });

  it('rejects a dirty worktree and an empty worktree at bundle time', async () => {
    await writeFile(
      path.join(
        root,
        'runner-data',
        'agents',
        SESSION,
        'work',
        'apps',
        APP_ID,
        'x',
      ),
      'dirty\n',
    );
    const sourcePath = path.join(
      root,
      'runner-data',
      'agents',
      SESSION,
      'work',
      'apps',
      APP_ID,
    );
    await expect(
      bundleWorktreeForDeploy(SESSION, 'app', APP_ID, GENERATION, sourcePath),
    ).rejects.toThrow(/dirty/);
    await rm(path.join(sourcePath, 'x'));

    await expect(
      bundleWorktreeForDeploy(
        SESSION,
        'app',
        'never-checked-out',
        GENERATION,
        path.join(
          root,
          'runner-data',
          'agents',
          SESSION,
          'work',
          'apps',
          'never-checked-out',
        ),
      ),
    ).rejects.toThrow(/not checked out/);
  });
});
