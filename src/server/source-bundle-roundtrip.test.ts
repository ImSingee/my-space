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

const SOURCE_KINDS = ['app', 'workflow'] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

type TestSource = {
  id: string;
  generation: string;
  masterCommit: string | null;
  bundleBase64: string | null;
};

async function commitAll(worktree: string, message: string): Promise<string> {
  await git(['add', '-A'], worktree);
  await git(['commit', '-m', message], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

async function seedPlatformSource(
  id: string,
  contents = 'v1\n',
): Promise<string> {
  const seed = path.join(root, `seed-${id}`);
  await mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch', 'master'], seed);
  await git(['config', 'user.email', 't@t'], seed);
  await git(['config', 'user.name', 't'], seed);
  await writeFile(path.join(seed, 'README.md'), contents);
  const commit = await commitAll(seed, `seed ${id}`);
  await platform.publishDeploymentSource(id, seed, 1);
  return commit;
}

async function exportSource(id: string): Promise<TestSource> {
  const [bundle, masterCommit] = await Promise.all([
    platform.exportMasterBundle(id),
    platform.masterCommit(id),
  ]);
  return {
    id,
    generation: GENERATION,
    masterCommit,
    bundleBase64: bundle?.toString('base64') ?? null,
  };
}

async function publishAgentChange(options: {
  kind: SourceKind;
  source: TestSource;
  sessionId: string;
  version: number;
  contents: string;
}): Promise<string> {
  const { kind, source, sessionId, version, contents } = options;
  const checkout = await checkoutFromBundle(sessionId, kind, source);
  await writeFile(path.join(checkout.absolutePath, 'README.md'), contents);
  const commit = await commitAll(checkout.absolutePath, `publish v${version}`);
  const deploy = await bundleWorktreeForDeploy(
    sessionId,
    kind,
    source.id,
    source.generation,
    checkout.absolutePath,
  );
  const staged = await platform.stageBundleCheckout(
    source.id,
    Buffer.from(deploy.bundleBase64, 'base64'),
  );
  try {
    await platform.publishDeploymentSource(source.id, staged.dir, version);
  } finally {
    await staged.cleanup();
  }
  return commit;
}

async function currentBranch(worktree: string): Promise<string | null> {
  return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktree).catch(
    () => null,
  );
}

async function expectSynchronizedCheckout(
  checkout: Awaited<ReturnType<typeof checkoutFromBundle>>,
  expectedCommit: string,
): Promise<void> {
  expect(checkout).toMatchObject({
    dirty: false,
    headCommit: expectedCommit,
    remoteCommit: expectedCommit,
    replacedExisting: false,
    synchronizedExisting: true,
  });
  await expect(currentBranch(checkout.absolutePath)).resolves.toBe('master');
  await expect(
    git(['rev-parse', 'refs/heads/master'], checkout.absolutePath),
  ).resolves.toBe(expectedCommit);
  await expect(
    git(['rev-parse', 'refs/remotes/origin/master'], checkout.absolutePath),
  ).resolves.toBe(expectedCommit);
  await expect(git(['status', '--short'], checkout.absolutePath)).resolves.toBe(
    '',
  );
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
    expect(checkout.synchronizedExisting).toBe(false);
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

  describe('existing checkout synchronization', () => {
    for (const kind of SOURCE_KINDS) {
      it(`synchronizes a clean ${kind} master already equal to remote`, async () => {
        const id = `sync-equal-${kind}`;
        const expectedCommit = await seedPlatformSource(id);
        const source = await exportSource(id);
        const sessionId = `${id}-session`;
        const fresh = await checkoutFromBundle(sessionId, kind, source);
        expect(fresh.synchronizedExisting).toBe(false);

        const synchronized = await checkoutFromBundle(sessionId, kind, source);

        await expectSynchronizedCheckout(synchronized, expectedCommit);
        await expect(
          readFile(path.join(synchronized.absolutePath, 'README.md'), 'utf8'),
        ).resolves.toBe('v1\n');
      });

      it(`advances a clean existing ${kind} master that is behind remote`, async () => {
        const id = `sync-behind-${kind}`;
        await seedPlatformSource(id);
        const initialSource = await exportSource(id);
        const sessionId = `${id}-session`;
        await checkoutFromBundle(sessionId, kind, initialSource);
        const expectedCommit = await publishAgentChange({
          kind,
          source: initialSource,
          sessionId: `${id}-publisher`,
          version: 2,
          contents: 'v2\n',
        });
        const advancedSource = await exportSource(id);

        const synchronized = await checkoutFromBundle(
          sessionId,
          kind,
          advancedSource,
        );

        await expectSynchronizedCheckout(synchronized, expectedCommit);
        await expect(
          readFile(path.join(synchronized.absolutePath, 'README.md'), 'utf8'),
        ).resolves.toBe('v2\n');
      });

      it(`materializes the first remote commit in an unborn clean ${kind} master`, async () => {
        const id = `sync-unborn-${kind}`;
        const sessionId = `${id}-session`;
        const emptySource: TestSource = {
          id,
          generation: GENERATION,
          masterCommit: null,
          bundleBase64: null,
        };
        const empty = await checkoutFromBundle(sessionId, kind, emptySource);
        expect(empty.headCommit).toBeNull();
        expect(empty.synchronizedExisting).toBe(false);
        const expectedCommit = await seedPlatformSource(id);
        const source = await exportSource(id);

        const synchronized = await checkoutFromBundle(sessionId, kind, source);

        await expectSynchronizedCheckout(synchronized, expectedCommit);
        await expect(
          readFile(path.join(synchronized.absolutePath, 'README.md'), 'utf8'),
        ).resolves.toBe('v1\n');
      });
    }

    for (const kind of SOURCE_KINDS) {
      for (const relation of ['ahead', 'diverged'] as const) {
        it(`preserves a clean ${kind} master that is ${relation} from remote`, async () => {
          const id = `sync-${relation}-${kind}`;
          await seedPlatformSource(id);
          const initialSource = await exportSource(id);
          const sessionId = `${id}-session`;
          const local = await checkoutFromBundle(
            sessionId,
            kind,
            initialSource,
          );
          await writeFile(
            path.join(local.absolutePath, 'local.txt'),
            'local-only\n',
          );
          const localCommit = await commitAll(
            local.absolutePath,
            'local-only commit',
          );
          let remoteSource = initialSource;
          if (relation === 'diverged') {
            await publishAgentChange({
              kind,
              source: initialSource,
              sessionId: `${id}-publisher`,
              version: 2,
              contents: 'remote-only\n',
            });
            remoteSource = await exportSource(id);
          }
          if (!remoteSource.masterCommit) {
            throw new Error('Expected committed remote source.');
          }

          await expect(
            checkoutFromBundle(sessionId, kind, remoteSource),
          ).rejects.toThrow(
            /local master.*commits.*platform master.*origin\/master.*refreshed/is,
          );
          await expect(currentBranch(local.absolutePath)).resolves.toBe(
            'master',
          );
          await expect(
            git(['rev-parse', 'HEAD'], local.absolutePath),
          ).resolves.toBe(localCommit);
          await expect(
            git(['rev-parse', 'refs/heads/master'], local.absolutePath),
          ).resolves.toBe(localCommit);
          await expect(
            git(
              ['rev-parse', 'refs/remotes/origin/master'],
              local.absolutePath,
            ),
          ).resolves.toBe(remoteSource.masterCommit);
          await expect(
            readFile(path.join(local.absolutePath, 'local.txt'), 'utf8'),
          ).resolves.toBe('local-only\n');
          await expect(
            git(['status', '--short'], local.absolutePath),
          ).resolves.toBe('');
        });
      }
    }

    for (const kind of SOURCE_KINDS) {
      for (const state of ['dirty', 'feature', 'detached'] as const) {
        it(`preserves an existing ${kind} checkout on ${state} state`, async () => {
          const id = `sync-${state}-${kind}`;
          await seedPlatformSource(id);
          const source = await exportSource(id);
          const sessionId = `${id}-session`;
          const local = await checkoutFromBundle(sessionId, kind, source);
          const head = await git(['rev-parse', 'HEAD'], local.absolutePath);
          if (state === 'dirty') {
            await writeFile(
              path.join(local.absolutePath, 'README.md'),
              'dirty\n',
            );
          } else if (state === 'feature') {
            await git(['switch', '-c', 'feature'], local.absolutePath);
          } else {
            await git(['switch', '--detach'], local.absolutePath);
          }

          await expect(
            checkoutFromBundle(sessionId, kind, source),
          ).rejects.toThrow(/already exists.*origin bundle was refreshed/is);
          await expect(
            git(['rev-parse', 'HEAD'], local.absolutePath),
          ).resolves.toBe(head);
          await expect(currentBranch(local.absolutePath)).resolves.toBe(
            state === 'detached'
              ? null
              : state === 'feature'
                ? 'feature'
                : 'master',
          );
          await expect(
            readFile(path.join(local.absolutePath, 'README.md'), 'utf8'),
          ).resolves.toBe(state === 'dirty' ? 'dirty\n' : 'v1\n');
          await expect(
            git(['status', '--short'], local.absolutePath),
          ).resolves.toBe(state === 'dirty' ? 'M README.md' : '');
        });
      }
    }
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
    expect(replacement.synchronizedExisting).toBe(false);
    expect(replacement.headCommit).toBeNull();
    await expect(
      readFile(path.join(old.absolutePath, 'README.md'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });

  for (const kind of SOURCE_KINDS) {
    it(`requires force to discard local ${kind} work against an empty remote`, async () => {
      const sessionId = `rt-empty-remote-${kind}`;
      const id = `empty-remote-${kind}`;
      const fresh = await initNewWorktree(sessionId, kind, id, GENERATION, () =>
        Promise.resolve(),
      );
      await writeFile(path.join(fresh.absolutePath, 'a.txt'), 'work\n');
      const localCommit = await commitAll(fresh.absolutePath, 'local work');
      const emptySource: TestSource = {
        id,
        generation: GENERATION,
        masterCommit: null,
        bundleBase64: null,
      };

      await expect(
        checkoutFromBundle(sessionId, kind, emptySource),
      ).rejects.toThrow(/already exists.*platform master is currently empty/);
      await expect(
        git(['rev-parse', 'HEAD'], fresh.absolutePath),
      ).resolves.toBe(localCommit);

      const replacement = await checkoutFromBundle(
        sessionId,
        kind,
        emptySource,
        { force: true },
      );
      expect(replacement.replacedExisting).toBe(true);
      expect(replacement.synchronizedExisting).toBe(false);
      expect(replacement.headCommit).toBeNull();
      await expect(
        readFile(path.join(replacement.absolutePath, 'a.txt'), 'utf8'),
      ).rejects.toThrow(/ENOENT/);
    });
  }

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
