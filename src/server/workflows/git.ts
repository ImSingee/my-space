/** Server-only: Git-backed source storage for Hatch workflows. */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agentWorkDir,
  agentWorkflowWorkDir,
  workflowDeployCheckoutDir,
  workflowRepoDir,
} from '~agent/paths';

export const WORKFLOW_SOURCE_BRANCH = 'master';
export const DEPLOY_TAG_PREFIX = 'deploy/';

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type WorkflowCheckout = {
  workflowId: string;
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
      echo "Hatch deploy owns tags; call deploy_workflow instead of pushing tags." >&2
      exit 1
      ;;
    refs/heads/*)
      echo "Hatch deploy owns branches; commit locally, rebase if needed, then call deploy_workflow." >&2
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

export async function ensureWorkflowRepo(id: string): Promise<string> {
  const repoDir = workflowRepoDir(id);
  if (!(await pathExists(repoDir))) {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await runGit([
      'init',
      '--bare',
      '--initial-branch',
      WORKFLOW_SOURCE_BRANCH,
      repoDir,
    ]);
  }
  await installServerHooks(repoDir);
  return repoDir;
}

async function refCommit(repoDir: string, ref: string): Promise<string | null> {
  const result = await runGit(
    ['--git-dir', repoDir, 'rev-parse', '--verify', ref],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

export async function workflowMasterCommit(id: string): Promise<string | null> {
  return refCommit(workflowRepoDir(id), `refs/heads/${WORKFLOW_SOURCE_BRANCH}`);
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

export async function worktreeOrigin(worktree: string): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', 'origin'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

async function describeCheckout(
  sessionId: string,
  id: string,
  worktree: string,
): Promise<WorkflowCheckout> {
  const [status, headCommit, remoteCommit] = await Promise.all([
    worktreeStatus(worktree),
    worktreeHead(worktree),
    workflowMasterCommit(id),
  ]);
  return {
    workflowId: id,
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

export async function checkoutWorkflowForAgent(
  sessionId: string,
  id: string,
): Promise<WorkflowCheckout> {
  const repoDir = await ensureWorkflowRepo(id);
  const worktree = agentWorkflowWorkDir(sessionId, id);
  const gitDir = path.join(worktree, '.git');

  if (await pathExists(worktree)) {
    if (!(await pathExists(gitDir))) {
      throw new Error(
        `Agent worktree exists but is not a Git checkout: ${worktree}`,
      );
    }
    // Apps and workflows share the chat worktree namespace (both appear as
    // `<id>/`), so guard against a slug already checked out for an app.
    const origin = await worktreeOrigin(worktree);
    if (origin && path.resolve(origin) !== path.resolve(repoDir)) {
      throw new Error(
        `"${id}/" in this chat is already checked out from a different repo ` +
          `(${origin}). Pick a different slug for this workflow.`,
      );
    }
    await setLocalGitIdentity(worktree);
    return describeCheckout(sessionId, id, worktree);
  }

  await mkdir(path.dirname(worktree), { recursive: true });
  const master = await workflowMasterCommit(id);
  if (master) {
    await runGit(['clone', repoDir, worktree]);
  } else {
    await mkdir(worktree, { recursive: true });
    await runGit(['init', '--initial-branch', WORKFLOW_SOURCE_BRANCH], {
      cwd: worktree,
    });
    await runGit(['remote', 'add', 'origin', repoDir], { cwd: worktree });
  }
  await setLocalGitIdentity(worktree);
  return describeCheckout(sessionId, id, worktree);
}

export async function prepareDeployCheckout(id: string): Promise<string> {
  const repoDir = await ensureWorkflowRepo(id);
  const master = await workflowMasterCommit(id);
  if (!master) {
    throw new Error(`Workflow "${id}" has no committed source on master yet.`);
  }
  const checkout = workflowDeployCheckoutDir(id);
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
  await ensureWorkflowRepo(id);
  const status = await worktreeStatus(worktree);
  if (status) {
    throw new Error(
      `Cannot deploy workflow "${id}" because the worktree is dirty.\n` +
        'Commit or discard these changes first:\n' +
        status,
    );
  }
  const commit = await worktreeHead(worktree);
  if (!commit) {
    throw new Error(
      `Cannot deploy workflow "${id}" because the worktree has no commits ` +
        'yet. Run git add and git commit first.',
    );
  }
  return commit;
}

export async function publishDeploymentSource(
  id: string,
  worktree: string,
  version: number,
): Promise<PublishedSource> {
  const repoDir = await ensureWorkflowRepo(id);
  const commit = await assertDeployableWorktree(id, worktree);
  await runGit(['fetch', 'origin', WORKFLOW_SOURCE_BRANCH], {
    cwd: worktree,
    allowFailure: true,
  });
  const master = await workflowMasterCommit(id);
  if (master) {
    const ff = await runGit(['merge-base', '--is-ancestor', master, commit], {
      cwd: worktree,
      allowFailure: true,
    });
    if (ff.exitCode !== 0) {
      throw new Error(
        `Cannot deploy workflow "${id}" because ${WORKFLOW_SOURCE_BRANCH} ` +
          `advanced. Run "git fetch origin ${WORKFLOW_SOURCE_BRANCH}" and ` +
          'rebase your work before deploying.',
      );
    }
  }

  const tag = `${DEPLOY_TAG_PREFIX}v${version}`;
  await runGit([
    '--git-dir',
    repoDir,
    'fetch',
    worktree,
    `HEAD:refs/heads/${WORKFLOW_SOURCE_BRANCH}`,
  ]);
  await runGit(['--git-dir', repoDir, 'tag', '-f', tag, commit]);
  return { commit, tag, repoPath: repoDir };
}

export async function deleteDeploymentTag(
  id: string,
  tag: string,
): Promise<void> {
  if (!tag.startsWith(DEPLOY_TAG_PREFIX)) return;
  const repoDir = workflowRepoDir(id);
  await runGit(['--git-dir', repoDir, 'tag', '-d', tag], {
    allowFailure: true,
  });
}

export async function moveMasterToDeploymentTag(
  id: string,
  tag: string,
): Promise<string> {
  const repoDir = await ensureWorkflowRepo(id);
  if (!tag.startsWith(DEPLOY_TAG_PREFIX)) {
    throw new Error(`Invalid deployment tag: ${tag}`);
  }
  const commit = await refCommit(repoDir, `refs/tags/${tag}`);
  if (!commit) throw new Error(`Deployment tag not found: ${tag}`);
  await runGit([
    '--git-dir',
    repoDir,
    'update-ref',
    `refs/heads/${WORKFLOW_SOURCE_BRANCH}`,
    commit,
  ]);
  return commit;
}
