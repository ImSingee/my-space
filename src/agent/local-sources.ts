/**
 * Runner-side source workspaces.
 *
 * The Agent Runner never touches the platform's canonical repositories.
 * Instead it materializes per-chat worktrees from git bundles served by the
 * platform's internal API, and packs local commits back into bundles for
 * deploys. Each checkout's `origin` points at its local bundle file, so
 * normal `git fetch origin master` / rebase flows keep working inside the
 * agent's shell.
 *
 * Layout under the runner's data dir (HATCH_DATA_DIR):
 *   agents/<sessionId>/work/<id>/                  ← agent-visible worktree
 *   agents/<sessionId>/bundles/<kind>-<id>.bundle  ← origin bundle (hidden)
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_HOME_DIR, AGENTS_DIR, agentWorkDir } from './paths';
import type { SourceBundleResponse } from './protocol';
import { sandboxSpawn } from './shell-sandbox';

export const SOURCE_BRANCH = 'master';

export type SourceKind = 'app' | 'workflow';

export type LocalCheckout = {
  id: string;
  /** Path relative to the chat work root (what the agent sees), e.g. "id/". */
  path: string;
  absolutePath: string;
  dirty: boolean;
  headCommit: string | null;
  /** Platform master commit at sync time (null when the repo is empty). */
  remoteCommit: string | null;
  status: string;
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Worktree `.git/config` is agent-writable (core.fsmonitor, filters,
    // hooks can execute code), so run git demoted to the sandbox user where
    // available and never hand it the runner's env (AGENT_RUNNER_TOKEN…).
    const wrapped = sandboxSpawn(['git', ...args]);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: AGENT_HOME_DIR,
        LANG: process.env.LANG,
        // Bundles/worktrees are local files; block config-smuggled remote
        // helpers from prompting and keep output deterministic.
        GIT_TERMINAL_PROMPT: '0',
      },
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function setLocalGitIdentity(worktree: string): Promise<void> {
  await runGit(['config', 'user.name', 'Hatch Agent'], { cwd: worktree });
  await runGit(['config', 'user.email', 'agent@hatch.local'], {
    cwd: worktree,
  });
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

async function worktreeOrigin(worktree: string): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', 'origin'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

function bundleFile(sessionId: string, kind: SourceKind, id: string): string {
  return path.resolve(AGENTS_DIR, sessionId, 'bundles', `${kind}-${id}.bundle`);
}

function worktreeDir(sessionId: string, id: string): string {
  return path.resolve(agentWorkDir(sessionId), id);
}

async function describeCheckout(
  sessionId: string,
  id: string,
  worktree: string,
  remoteCommit: string | null,
): Promise<LocalCheckout> {
  const [status, headCommit] = await Promise.all([
    worktreeStatus(worktree),
    worktreeHead(worktree),
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

/**
 * Guard the shared `<id>/` worktree namespace: apps and workflows may reuse a
 * slug, and a worktree from another entity must never be silently reused (a
 * deploy would push the wrong repo). The origin URL — our per-kind bundle
 * path — is the discriminator, exactly like the canonical-repo origin was in
 * the single-process design.
 */
async function assertOwnedWorktree(
  worktree: string,
  bundle: string,
  id: string,
  kind: SourceKind,
): Promise<void> {
  if (!(await pathExists(path.join(worktree, '.git')))) {
    throw new Error(
      `Agent worktree exists but is not a Git checkout: ${worktree}`,
    );
  }
  const origin = await worktreeOrigin(worktree);
  if (origin && path.resolve(origin) !== path.resolve(bundle)) {
    throw new Error(
      `"${id}/" in this chat is already checked out from a different ` +
        `repo (${origin}). Pick a different slug for this ${kind}.`,
    );
  }
}

/**
 * Ids are user-reusable (delete a workflow, recreate it under the same id)
 * and platform deletion cannot clean runner-local worktrees. A stale worktree
 * from the previous incarnation would then silently mix two unrelated repo
 * histories, so reject the checkout when the local HEAD shares no ancestor
 * with the freshly fetched platform master.
 */
async function assertRelatedHistory(
  worktree: string,
  id: string,
  kind: SourceKind,
): Promise<void> {
  const head = await worktreeHead(worktree);
  if (!head) return;
  const remoteRef = `origin/${SOURCE_BRANCH}`;
  const remote = await runGit(['rev-parse', '--verify', remoteRef], {
    cwd: worktree,
    allowFailure: true,
  });
  if (remote.exitCode !== 0) return; // fetch failed / remote still empty
  const base = await runGit(['merge-base', 'HEAD', remoteRef], {
    cwd: worktree,
    allowFailure: true,
  });
  if (base.exitCode !== 0) {
    throw new Error(
      `"${id}/" in this chat has history unrelated to the current ${kind} ` +
        `repo — it is likely left over from a deleted ${kind} that was ` +
        `recreated under the same id. Remove it (run_command: rm -rf ${id}) ` +
        'and run the checkout again.',
    );
  }
}

/**
 * The empty-remote counterpart of {@link assertRelatedHistory}: the canonical
 * repo only ever fast-forwards within one incarnation of an entity, so a
 * local `origin/master` ref combined with a now-empty platform repo proves
 * the entity was deleted and recreated under a reused id. Without this check
 * the leftover worktree would be reported as a valid checkout and a deploy
 * would publish the previous incarnation's code. (A worktree with only local
 * never-synced commits is indistinguishable from legitimate pre-first-deploy
 * work and is deliberately kept.)
 */
async function assertNotStaleForEmptyRemote(
  worktree: string,
  id: string,
  kind: SourceKind,
): Promise<void> {
  const remote = await runGit(
    ['rev-parse', '--verify', `origin/${SOURCE_BRANCH}`],
    { cwd: worktree, allowFailure: true },
  );
  if (remote.exitCode !== 0) return;
  throw new Error(
    `"${id}/" in this chat tracks commits from a previous ${kind} that no ` +
      `longer exists on the platform — the current ${kind} "${id}" has an ` +
      `empty repo. Remove the stale directory (run_command: rm -rf ${id}) ` +
      'and run the checkout again.',
  );
}

/**
 * Materialize (or refresh) the worktree for an existing app/workflow from
 * the platform-served source bundle. Existing local commits/changes are kept;
 * `origin/master` is updated so the agent can fetch/rebase as usual.
 */
export async function syncCheckoutFromBundle(
  sessionId: string,
  kind: SourceKind,
  source: SourceBundleResponse,
): Promise<LocalCheckout> {
  const { id } = source;
  const worktree = worktreeDir(sessionId, id);
  const bundle = bundleFile(sessionId, kind, id);
  await mkdir(path.dirname(bundle), { recursive: true });

  if (source.bundleBase64) {
    await writeFile(bundle, Buffer.from(source.bundleBase64, 'base64'));
  } else {
    // Empty platform repo: drop any leftover bundle from a previous
    // incarnation of this id so a manual `git fetch origin` in a fresh
    // worktree cannot resurrect the old refs.
    await rm(bundle, { force: true });
  }

  if (await pathExists(worktree)) {
    await assertOwnedWorktree(worktree, bundle, id, kind);
    if (source.bundleBase64) {
      // Refresh origin/master from the new bundle; merging/rebasing stays the
      // agent's own git decision, mirroring the old canonical-repo fetch.
      await runGit(['fetch', 'origin', SOURCE_BRANCH], {
        cwd: worktree,
        allowFailure: true,
      });
      await assertRelatedHistory(worktree, id, kind);
    } else {
      await assertNotStaleForEmptyRemote(worktree, id, kind);
    }
    await setLocalGitIdentity(worktree);
    return describeCheckout(sessionId, id, worktree, source.masterCommit);
  }

  await mkdir(path.dirname(worktree), { recursive: true });
  if (source.bundleBase64) {
    await runGit(['clone', bundle, worktree]);
    // Clone records the (session-relative) bundle path as origin; normalize
    // to the absolute path so the ownership check compares stable values.
    await runGit(['remote', 'set-url', 'origin', bundle], { cwd: worktree });
  } else {
    // Let (possibly UID-demoted) git create the directory itself so the
    // repo's owner matches the uid git later runs as (safe.directory).
    await runGit(['init', '--initial-branch', SOURCE_BRANCH, worktree]);
    await runGit(['remote', 'add', 'origin', bundle], { cwd: worktree });
  }
  await setLocalGitIdentity(worktree);
  return describeCheckout(sessionId, id, worktree, source.masterCommit);
}

/**
 * Preflight for creating a new entity under a caller-chosen id: fail BEFORE
 * the platform registers the id when the local directory is already taken
 * (otherwise the create would leave an orphan draft row behind and retrying
 * the same id would hit "already exists" on the platform side).
 *
 * The directory may also be a leftover from an entity that was deleted on
 * the platform (worktrees are runner-local, so platform deletion cannot
 * clean them) — tell the agent how to resolve that itself.
 */
export async function assertWorktreeAvailable(
  sessionId: string,
  id: string,
): Promise<void> {
  if (await pathExists(worktreeDir(sessionId, id))) {
    throw new Error(
      `"${id}/" already exists in this chat's worktree. If it belongs to a ` +
        `deleted app/workflow, remove it first (run_command: rm -rf ${id}); ` +
        'otherwise check it out or pick a different id.',
    );
  }
}

/**
 * Initialize the worktree for a freshly created app/workflow and write the
 * platform-rendered scaffold files into it (uncommitted, like before — the
 * agent reviews, edits, and commits).
 */
export async function initNewWorktree(
  sessionId: string,
  kind: SourceKind,
  id: string,
  writeFiles: (root: string) => Promise<void>,
): Promise<LocalCheckout> {
  const worktree = worktreeDir(sessionId, id);
  const bundle = bundleFile(sessionId, kind, id);
  await mkdir(path.dirname(bundle), { recursive: true });

  // Backstop; creators preflight with assertWorktreeAvailable before the
  // platform row exists.
  await assertWorktreeAvailable(sessionId, id);

  await mkdir(path.dirname(worktree), { recursive: true });
  // Let (possibly UID-demoted) git create the worktree dir itself so the
  // repo's owner matches the uid git runs as (git's safe.directory check).
  await runGit(['init', '--initial-branch', SOURCE_BRANCH, worktree]);
  await runGit(['remote', 'add', 'origin', bundle], { cwd: worktree });
  await setLocalGitIdentity(worktree);
  await writeFiles(worktree);
  return describeCheckout(sessionId, id, worktree, null);
}

/**
 * Pack the worktree's committed state into a git bundle for upload. Mirrors
 * the platform-side deployability checks so the agent gets the same actionable
 * errors without a round-trip (the platform re-verifies regardless).
 */
export async function bundleWorktreeForDeploy(
  sessionId: string,
  kind: SourceKind,
  id: string,
): Promise<{ bundleBase64: string; headCommit: string }> {
  const worktree = worktreeDir(sessionId, id);
  const bundle = bundleFile(sessionId, kind, id);
  if (!(await pathExists(worktree))) {
    throw new Error(
      `${kind} "${id}" is not checked out in this chat. Run checkout first.`,
    );
  }
  await assertOwnedWorktree(worktree, bundle, id, kind);

  const status = await worktreeStatus(worktree);
  if (status) {
    throw new Error(
      `Cannot deploy ${kind} "${id}" because the worktree is dirty.\n` +
        'Commit or discard these changes first:\n' +
        status,
    );
  }
  const headCommit = await worktreeHead(worktree);
  if (!headCommit) {
    throw new Error(
      `Cannot deploy ${kind} "${id}" because the worktree has no ` +
        'commits yet. Run git add and git commit first.',
    );
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-runner-bundle-'));
  // mkdtemp creates 0700 dirs owned by the runner; the (possibly UID-demoted)
  // git below must be able to write the bundle into it.
  await chmod(tmp, 0o777);
  const out = path.join(tmp, 'deploy.bundle');
  try {
    // --all + HEAD: self-contained bundle carrying every local ref, so the
    // platform can clone it and fast-forward its canonical master from HEAD.
    await runGit(['bundle', 'create', out, '--all', 'HEAD'], {
      cwd: worktree,
    });
    const data = await readFile(out);
    return { bundleBase64: data.toString('base64'), headCommit };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
