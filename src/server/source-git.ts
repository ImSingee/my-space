/**
 * Server-only: shared Git-backed source storage engine.
 *
 * Apps and workflows store source identically -- a bare repo per entity,
 * namespaced Agent worktrees under each chat session, deploy tags owned by the
 * platform. This
 * module implements that engine once; `apps/git.ts` and `workflows/git.ts` are
 * thin instantiations that plug in their own paths and wording.
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentWorkDir } from '~agent/paths';

export const SOURCE_BRANCH = 'master';
export const DEPLOY_TAG_PREFIX = 'deploy/';

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SourceCheckout = {
  id: string;
  path: string;
  absolutePath: string;
  dirty: boolean;
  headCommit: string | null;
  remoteCommit: string | null;
  status: string;
};

export type PublishedSource = {
  commit: string;
  tag: string;
  repoPath: string;
};

export type GitSourceConfig = {
  /** Noun used in error messages ("app" / "workflow"). */
  noun: string;
  /** Agent tool name mentioned by the push-blocking server hook. */
  deployTool: string;
  repoDir: (id: string) => string;
  deployCheckoutDir: (id: string) => string;
  agentCheckoutDir: (sessionId: string, id: string) => string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

async function runGit(
  args: string[],
  opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const result = await git(args, opts);
  if (!opts.allowFailure && result.exitCode !== 0) {
    const message = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
  return result;
}

async function setLocalGitIdentity(worktree: string): Promise<void> {
  await runGit(['config', 'user.name', 'Hatch Agent'], { cwd: worktree });
  await runGit(['config', 'user.email', 'agent@hatch.local'], {
    cwd: worktree,
  });
}

async function refCommit(repoDir: string, ref: string): Promise<string | null> {
  const result = await runGit(
    ['--git-dir', repoDir, 'rev-parse', '--verify', ref],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

async function worktreeHead(worktree: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

async function worktreeStatus(worktree: string): Promise<string> {
  const result = await runGit(['status', '--short'], { cwd: worktree });
  return result.stdout.trim();
}

/** Remote `origin` URL of a worktree, or null when unset. */
export async function worktreeOrigin(worktree: string): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', 'origin'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

export function createGitSource(cfg: GitSourceConfig) {
  async function installServerHooks(repoDir: string): Promise<void> {
    const hook = path.join(repoDir, 'hooks', 'pre-receive');
    await writeFile(
      hook,
      `#!/bin/sh
while read oldrev newrev refname; do
  case "$refname" in
    refs/tags/*)
      echo "Hatch deploy owns tags; call ${cfg.deployTool} instead of pushing tags." >&2
      exit 1
      ;;
    refs/heads/*)
      echo "Hatch deploy owns branches; commit locally, rebase if needed, then call ${cfg.deployTool}." >&2
      exit 1
      ;;
    *)
      echo "Unsupported ref update: $refname" >&2
      exit 1
      ;;
  esac
done
exit 0
`,
      { mode: 0o755 },
    );
  }

  async function ensureRepo(id: string): Promise<string> {
    const repoDir = cfg.repoDir(id);
    if (!(await pathExists(repoDir))) {
      await mkdir(path.dirname(repoDir), { recursive: true });
      await runGit([
        'init',
        '--bare',
        '--initial-branch',
        SOURCE_BRANCH,
        repoDir,
      ]);
    }
    await installServerHooks(repoDir);
    return repoDir;
  }

  async function masterCommit(id: string): Promise<string | null> {
    return refCommit(cfg.repoDir(id), `refs/heads/${SOURCE_BRANCH}`);
  }

  async function describeCheckout(
    sessionId: string,
    id: string,
    worktree: string,
  ): Promise<SourceCheckout> {
    const [status, headCommit, remoteCommit] = await Promise.all([
      worktreeStatus(worktree),
      worktreeHead(worktree),
      masterCommit(id),
    ]);
    return {
      id,
      path: path
        .relative(agentWorkDir(sessionId), worktree)
        .split(path.sep)
        .join('/'),
      absolutePath: worktree,
      dirty: status.length > 0,
      headCommit,
      remoteCommit,
      status,
    };
  }

  async function checkoutForAgent(
    sessionId: string,
    id: string,
  ): Promise<SourceCheckout> {
    const repoDir = await ensureRepo(id);
    const worktree = cfg.agentCheckoutDir(sessionId, id);
    const gitDir = path.join(worktree, '.git');

    if (await pathExists(worktree)) {
      if (!(await pathExists(gitDir))) {
        throw new Error(
          `Agent worktree exists but is not a Git checkout: ${worktree}`,
        );
      }
      // Never reuse a custom/stale checkout from another repository.
      const origin = await worktreeOrigin(worktree);
      if (!origin || path.resolve(origin) !== path.resolve(repoDir)) {
        throw new Error(
          `Agent worktree is not a checkout of ${cfg.noun} "${id}" ` +
            `(expected origin ${repoDir}, found ${origin ?? 'no origin'}).`,
        );
      }
      await setLocalGitIdentity(worktree);
      return describeCheckout(sessionId, id, worktree);
    }

    await mkdir(path.dirname(worktree), { recursive: true });
    const master = await masterCommit(id);
    if (master) {
      await runGit(['clone', repoDir, worktree]);
    } else {
      await mkdir(worktree, { recursive: true });
      await runGit(['init', '--initial-branch', SOURCE_BRANCH], {
        cwd: worktree,
      });
      await runGit(['remote', 'add', 'origin', repoDir], { cwd: worktree });
    }
    await setLocalGitIdentity(worktree);
    return describeCheckout(sessionId, id, worktree);
  }

  async function prepareDeployCheckout(id: string): Promise<string> {
    const repoDir = await ensureRepo(id);
    const master = await masterCommit(id);
    if (!master) {
      throw new Error(
        `${capitalize(cfg.noun)} "${id}" has no committed source on master yet.`,
      );
    }
    const checkout = cfg.deployCheckoutDir(id);
    await rm(checkout, { recursive: true, force: true });
    await mkdir(path.dirname(checkout), { recursive: true });
    await runGit(['clone', repoDir, checkout]);
    await setLocalGitIdentity(checkout);
    return checkout;
  }

  async function assertDeployableWorktree(
    id: string,
    worktree: string,
  ): Promise<string> {
    await ensureRepo(id);
    const status = await worktreeStatus(worktree);
    if (status) {
      throw new Error(
        `Cannot deploy ${cfg.noun} "${id}" because the worktree is dirty.\n` +
          'Commit or discard these changes first:\n' +
          status,
      );
    }
    const commit = await worktreeHead(worktree);
    if (!commit) {
      throw new Error(
        `Cannot deploy ${cfg.noun} "${id}" because the worktree has no ` +
          'commits yet. Run git add and git commit first.',
      );
    }
    return commit;
  }

  async function publishDeploymentSource(
    id: string,
    worktree: string,
    version: number,
  ): Promise<PublishedSource> {
    const repoDir = await ensureRepo(id);
    const commit = await assertDeployableWorktree(id, worktree);
    await runGit(['fetch', 'origin', SOURCE_BRANCH], {
      cwd: worktree,
      allowFailure: true,
    });
    const master = await masterCommit(id);
    if (master) {
      const ff = await runGit(['merge-base', '--is-ancestor', master, commit], {
        cwd: worktree,
        allowFailure: true,
      });
      if (ff.exitCode !== 0) {
        throw new Error(
          `Cannot deploy ${cfg.noun} "${id}" because ${SOURCE_BRANCH} ` +
            `advanced. Run "git fetch origin ${SOURCE_BRANCH}" and rebase ` +
            'your work before deploying.',
        );
      }
    }

    // Tags are named by release version (deploy/v1, deploy/v2, ...). The
    // version is assigned from successful-deployment history, so any
    // pre-existing tag for this version is a stale leftover from a failed
    // attempt whose cleanup didn't run (e.g. the process was killed).
    // Force-move it onto the new commit rather than failing the deploy.
    const tag = `${DEPLOY_TAG_PREFIX}v${version}`;

    await runGit([
      '--git-dir',
      repoDir,
      'fetch',
      worktree,
      `HEAD:refs/heads/${SOURCE_BRANCH}`,
    ]);
    await runGit(['--git-dir', repoDir, 'tag', '-f', tag, commit]);
    return { commit, tag, repoPath: repoDir };
  }

  /**
   * Delete a deployment tag. Used to roll back the tag created for a deploy
   * that failed after tagging, so a failed attempt leaves no Git history —
   * mirroring the database, which records no deployment row for failures.
   */
  async function deleteDeploymentTag(id: string, tag: string): Promise<void> {
    if (!tag.startsWith(DEPLOY_TAG_PREFIX)) return;
    await runGit(['--git-dir', cfg.repoDir(id), 'tag', '-d', tag], {
      allowFailure: true,
    });
  }

  /**
   * Export the canonical master branch as a git bundle for the Agent Runner
   * to clone/fetch from. Returns null when the repo has no commits yet.
   */
  async function exportMasterBundle(id: string): Promise<Buffer | null> {
    const repoDir = await ensureRepo(id);
    const master = await masterCommit(id);
    if (!master) return null;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-bundle-'));
    const bundleFile = path.join(tmp, 'source.bundle');
    try {
      await runGit([
        '--git-dir',
        repoDir,
        'bundle',
        'create',
        bundleFile,
        SOURCE_BRANCH,
      ]);
      return await readFile(bundleFile);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Stage a runner-uploaded bundle as a temporary deploy checkout: verify the
   * bundle, clone it, and point `origin` at the canonical repo. The result
   * plugs into the existing deploy pipeline (`deployApp(sourceDir)`), which
   * re-runs the clean/fast-forward checks and only advances master AFTER the
   * build succeeds — identical semantics to deploying from an agent worktree.
   */
  async function stageBundleCheckout(
    id: string,
    bundle: Buffer,
  ): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const repoDir = await ensureRepo(id);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-deploy-'));
    const cleanup = () => rm(tmp, { recursive: true, force: true });
    try {
      const bundleFile = path.join(tmp, 'incoming.bundle');
      const dir = path.join(tmp, 'src');
      await writeFile(bundleFile, bundle);
      const verify = await runGit(
        ['--git-dir', repoDir, 'bundle', 'verify', bundleFile],
        { allowFailure: true },
      );
      // A bundle with prerequisites missing from the canonical repo fails
      // verify — the runner's checkout is based on history this repo doesn't
      // have. Same guidance as the worktree path's "master advanced" error.
      if (verify.exitCode !== 0) {
        throw new Error(
          `Cannot deploy ${cfg.noun} "${id}": the uploaded source bundle ` +
            `does not apply to the canonical repository. Run checkout again ` +
            `to sync with ${SOURCE_BRANCH}, rebase your work, then retry.\n` +
            (verify.stderr || verify.stdout).trim(),
        );
      }
      await runGit(['clone', bundleFile, dir]);
      // Point origin at the canonical repo so the deploy pipeline's
      // fetch + fast-forward check compare against the real master.
      await runGit(['remote', 'set-url', 'origin', repoDir], { cwd: dir });
      await setLocalGitIdentity(dir);
      return { dir, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async function moveMasterToDeploymentTag(
    id: string,
    tag: string,
  ): Promise<string> {
    const repoDir = await ensureRepo(id);
    if (!tag.startsWith(DEPLOY_TAG_PREFIX)) {
      throw new Error(`Invalid deployment tag: ${tag}`);
    }
    const commit = await refCommit(repoDir, `refs/tags/${tag}`);
    if (!commit) throw new Error(`Deployment tag not found: ${tag}`);
    await runGit([
      '--git-dir',
      repoDir,
      'update-ref',
      `refs/heads/${SOURCE_BRANCH}`,
      commit,
    ]);
    return commit;
  }

  return {
    ensureRepo,
    masterCommit,
    checkoutForAgent,
    prepareDeployCheckout,
    assertDeployableWorktree,
    publishDeploymentSource,
    deleteDeploymentTag,
    moveMasterToDeploymentTag,
    exportMasterBundle,
    stageBundleCheckout,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
