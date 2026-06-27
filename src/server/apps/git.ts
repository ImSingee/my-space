/** Server-only: Git-backed source storage for Hatch apps. */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentAppWorkDir,
  appDeployCheckoutDir,
  appRepoDir,
  agentWorkDir,
} from '~agent/paths';

export const APP_SOURCE_BRANCH = 'master';
export const DEPLOY_TAG_PREFIX = 'deploy/';

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AppCheckout = {
  appId: string;
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

async function installServerHooks(repoDir: string): Promise<void> {
  const hook = path.join(repoDir, 'hooks', 'pre-receive');
  await writeFile(
    hook,
    `#!/bin/sh
while read oldrev newrev refname; do
  case "$refname" in
    refs/tags/*)
      echo "Hatch deploy owns tags; call deploy_app instead of pushing tags." >&2
      exit 1
      ;;
    refs/heads/*)
      echo "Hatch deploy owns branches; commit locally, rebase if needed, then call deploy_app." >&2
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

async function setLocalGitIdentity(worktree: string): Promise<void> {
  await runGit(['config', 'user.name', 'Hatch Agent'], { cwd: worktree });
  await runGit(['config', 'user.email', 'agent@hatch.local'], {
    cwd: worktree,
  });
}

export async function ensureAppRepo(id: string): Promise<string> {
  const repoDir = appRepoDir(id);
  if (!(await pathExists(repoDir))) {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await runGit([
      'init',
      '--bare',
      '--initial-branch',
      APP_SOURCE_BRANCH,
      repoDir,
    ]);
  }
  await installServerHooks(repoDir);
  return repoDir;
}

async function refCommit(repoDir: string, ref: string): Promise<string | null> {
  const result = await runGit(
    ['--git-dir', repoDir, 'rev-parse', '--verify', ref],
    {
      allowFailure: true,
    },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

export async function appMasterCommit(id: string): Promise<string | null> {
  return refCommit(appRepoDir(id), `refs/heads/${APP_SOURCE_BRANCH}`);
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

async function describeCheckout(
  sessionId: string,
  id: string,
  worktree: string,
): Promise<AppCheckout> {
  const [status, headCommit, remoteCommit] = await Promise.all([
    worktreeStatus(worktree),
    worktreeHead(worktree),
    appMasterCommit(id),
  ]);
  return {
    appId: id,
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

export async function checkoutAppForAgent(
  sessionId: string,
  id: string,
): Promise<AppCheckout> {
  const repoDir = await ensureAppRepo(id);
  const worktree = agentAppWorkDir(sessionId, id);
  const gitDir = path.join(worktree, '.git');

  if (await pathExists(worktree)) {
    if (!(await pathExists(gitDir))) {
      throw new Error(
        `Agent worktree exists but is not a Git checkout: ${worktree}`,
      );
    }
    await setLocalGitIdentity(worktree);
    return describeCheckout(sessionId, id, worktree);
  }

  await mkdir(path.dirname(worktree), { recursive: true });
  const master = await appMasterCommit(id);
  if (master) {
    await runGit(['clone', repoDir, worktree]);
  } else {
    await mkdir(worktree, { recursive: true });
    await runGit(['init', '--initial-branch', APP_SOURCE_BRANCH], {
      cwd: worktree,
    });
    await runGit(['remote', 'add', 'origin', repoDir], { cwd: worktree });
  }
  await setLocalGitIdentity(worktree);
  return describeCheckout(sessionId, id, worktree);
}

export async function prepareDeployCheckout(id: string): Promise<string> {
  const repoDir = await ensureAppRepo(id);
  const master = await appMasterCommit(id);
  if (!master) {
    throw new Error(`App "${id}" has no committed source on master yet.`);
  }
  const checkout = appDeployCheckoutDir(id);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(path.dirname(checkout), { recursive: true });
  await runGit(['clone', repoDir, checkout]);
  await setLocalGitIdentity(checkout);
  return checkout;
}

export async function assertDeployableWorktree(
  id: string,
  worktree: string,
): Promise<string> {
  await ensureAppRepo(id);
  const status = await worktreeStatus(worktree);
  if (status) {
    throw new Error(
      `Cannot deploy app "${id}" because the worktree is dirty.\n` +
        'Commit or discard these changes first:\n' +
        status,
    );
  }
  const commit = await worktreeHead(worktree);
  if (!commit) {
    throw new Error(
      `Cannot deploy app "${id}" because the worktree has no commits yet. ` +
        'Run git add and git commit first.',
    );
  }
  return commit;
}

export async function publishDeploymentSource(
  id: string,
  worktree: string,
  version: number,
): Promise<PublishedSource> {
  const repoDir = await ensureAppRepo(id);
  const commit = await assertDeployableWorktree(id, worktree);
  await runGit(['fetch', 'origin', APP_SOURCE_BRANCH], {
    cwd: worktree,
    allowFailure: true,
  });
  const master = await appMasterCommit(id);
  if (master) {
    const ff = await runGit(['merge-base', '--is-ancestor', master, commit], {
      cwd: worktree,
      allowFailure: true,
    });
    if (ff.exitCode !== 0) {
      throw new Error(
        `Cannot deploy app "${id}" because ${APP_SOURCE_BRANCH} advanced. ` +
          `Run "git fetch origin ${APP_SOURCE_BRANCH}" and rebase your work ` +
          'before deploying.',
      );
    }
  }

  // Tags are named by release version (deploy/v1, deploy/v2, ...). The version
  // is assigned from successful-deployment history, so any pre-existing tag for
  // this version is a stale leftover from a failed attempt whose cleanup didn't
  // run (e.g. the process was killed). Force-move it onto the new commit rather
  // than failing the deploy.
  const tag = `${DEPLOY_TAG_PREFIX}v${version}`;

  await runGit([
    '--git-dir',
    repoDir,
    'fetch',
    worktree,
    `HEAD:refs/heads/${APP_SOURCE_BRANCH}`,
  ]);
  await runGit(['--git-dir', repoDir, 'tag', '-f', tag, commit]);
  return { commit, tag, repoPath: repoDir };
}

/**
 * Delete a deployment tag. Used to roll back the tag created for a deploy that
 * failed after tagging, so a failed attempt leaves no Git history — mirroring
 * the database, which records no deployment row for failures.
 */
export async function deleteDeploymentTag(
  id: string,
  tag: string,
): Promise<void> {
  if (!tag.startsWith(DEPLOY_TAG_PREFIX)) return;
  const repoDir = appRepoDir(id);
  await runGit(['--git-dir', repoDir, 'tag', '-d', tag], {
    allowFailure: true,
  });
}

export async function moveMasterToDeploymentTag(
  id: string,
  tag: string,
): Promise<string> {
  const repoDir = await ensureAppRepo(id);
  if (!tag.startsWith(DEPLOY_TAG_PREFIX)) {
    throw new Error(`Invalid deployment tag: ${tag}`);
  }
  const commit = await refCommit(repoDir, `refs/tags/${tag}`);
  if (!commit) throw new Error(`Deployment tag not found: ${tag}`);
  await runGit([
    '--git-dir',
    repoDir,
    'update-ref',
    `refs/heads/${APP_SOURCE_BRANCH}`,
    commit,
  ]);
  return commit;
}
