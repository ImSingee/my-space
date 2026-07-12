/**
 * Full platform <-> runner source transfer round-trip over git bundles:
 *
 *   platform exportMasterBundle -> runner syncCheckoutFromBundle -> agent
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
const { bundleWorktreeForDeploy, initNewWorktree, syncCheckoutFromBundle } =
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
    const checkout = await syncCheckoutFromBundle(SESSION, 'app', {
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

  it('re-sync refreshes origin/master without touching local state', async () => {
    // Master moved to v2 in the previous test; the runner still has its own
    // checkout. A fresh export + sync must update origin/master in place.
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const checkout = await syncCheckoutFromBundle(SESSION, 'app', {
      id: APP_ID,
      generation: GENERATION,
      masterCommit: master,
      bundleBase64: exported!.toString('base64'),
    });
    expect(checkout.remoteCommit).toBe(master);
    const originMaster = await git(
      ['rev-parse', 'origin/master'],
      checkout.absolutePath,
    );
    expect(originMaster).toBe(master);
  });

  it('rejects a stale bundle that is not a fast-forward of master', async () => {
    // A second session syncs, commits on top of v2… ------------------------
    const exported = await platform.exportMasterBundle(APP_ID);
    const master = await platform.masterCommit(APP_ID);
    const stale = await syncCheckoutFromBundle('rt-stale', 'app', {
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
    const winner = await syncCheckoutFromBundle('rt-winner', 'app', {
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

  it('rejects a synced checkout when the entity was recreated with an empty repo', async () => {
    // The worktree from the tests above tracks origin/master of the old
    // incarnation. If the app is deleted and recreated under the same id,
    // the platform serves an EMPTY source (no bundle) — the sync must refuse
    // to present the leftover worktree as a valid checkout of the new app.
    await expect(
      syncCheckoutFromBundle(SESSION, 'app', {
        id: APP_ID,
        generation: NEXT_GENERATION,
        masterCommit: null,
        bundleBase64: null,
      }),
    ).rejects.toThrow(/previous incarnation/);
  });

  it('keeps a never-synced worktree when the remote is still empty', async () => {
    // Legit pre-first-deploy flow: initNewWorktree + local commits, then a
    // re-checkout while the platform repo is still empty. No origin/master
    // ref exists locally, so this must NOT be treated as stale.
    const fresh = await initNewWorktree(
      'rt-fresh',
      'app',
      'new-app',
      GENERATION,
      () => Promise.resolve(),
    );
    await writeFile(path.join(fresh.absolutePath, 'a.txt'), 'work\n');
    const localCommit = await commitAll(fresh.absolutePath, 'local work');
    const again = await syncCheckoutFromBundle('rt-fresh', 'app', {
      id: 'new-app',
      generation: GENERATION,
      masterCommit: null,
      bundleBase64: null,
    });
    expect(again.headCommit).toBe(localCommit);
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
