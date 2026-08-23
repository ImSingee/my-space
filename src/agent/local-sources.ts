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
 *   agents/<sessionId>/work/apps/<id>/             ← app worktree
 *   agents/<sessionId>/work/workflows/<id>/        ← workflow worktree
 *   agents/<sessionId>/work/attachments/<id>/...   ← downloaded attachments
 *   agents/<sessionId>/bundles/<kind>-<id>.bundle  ← origin bundle (hidden)
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  agentAppWorkDir,
  agentHomeDir,
  agentSessionDir,
  agentWorkDir,
  agentWorkflowWorkDir,
  isSafeEntityId,
} from './paths';
import type { SourceBundleResponse } from './protocol';
import {
  prepareAgentSessionSandbox,
  sandboxSpawn,
  setAgentOwned,
  setRunnerOwned,
} from './shell-sandbox';
import {
  isWorkspacePathInside,
  resolveAgentWorkspacePath,
  type AgentWorkspacePath,
} from './workspace-paths';
import {
  materializeWorktree,
  prepareWorktreeMaterialization,
  type WorktreeMaterializer,
} from './worktree-materializer';

export const SOURCE_BRANCH = 'master';

export type SourceKind = 'app' | 'workflow';

export type LocalCheckout = {
  id: string;
  /** Path relative to the chat work root, e.g. "apps/id". */
  path: string;
  absolutePath: string;
  dirty: boolean;
  headCommit: string | null;
  /** Platform master commit at sync time (null when the repo is empty). */
  remoteCommit: string | null;
  status: string;
  /** Whether this checkout replaced an existing filesystem entry. */
  replacedExisting: boolean;
  /** Whether an existing clean master checkout was synchronized in place. */
  synchronizedExisting: boolean;
};

export type CheckoutFromBundleOptions = {
  targetPath?: string;
  force?: boolean;
  /** Defaults to the legacy create-or-update behavior used by workflows. */
  mode?: 'clone' | 'update' | 'upsert';
  materializer?: WorktreeMaterializer;
};

const workspaceMutationChains = new Map<string, Promise<unknown>>();

export function withSourceWorkspaceLock<T>(
  sessionId: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const tail = workspaceMutationChains.get(sessionId) ?? Promise.resolve();
  const runTask = () => {
    if (signal?.aborted) {
      throw new Error('Source workspace operation was aborted.');
    }
    return task();
  };
  const result = tail.then(runTask, runTask);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  workspaceMutationChains.set(sessionId, settled);
  void settled.then(() => {
    if (workspaceMutationChains.get(sessionId) === settled) {
      workspaceMutationChains.delete(sessionId);
    }
  });
  return result;
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function git(
  sessionId: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    // Worktree `.git/config` is agent-writable (core.fsmonitor, filters,
    // hooks can execute code), so run git demoted to the sandbox user where
    // available and never hand it the runner's env (AGENT_RUNNER_TOKEN…).
    const wrapped = sandboxSpawn(['git', ...args], sessionId);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: agentHomeDir(sessionId),
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
  sessionId: string,
  args: string[],
  opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const result = await git(sessionId, args, opts);
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

/** Like pathExists, but dangling symlinks also count as occupied paths. */
async function pathEntryExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function setLocalGitIdentity(
  sessionId: string,
  worktree: string,
): Promise<void> {
  await runGit(sessionId, ['config', 'user.name', 'Hatch Agent'], {
    cwd: worktree,
  });
  await runGit(sessionId, ['config', 'user.email', 'agent@hatch.local'], {
    cwd: worktree,
  });
}

async function worktreeHead(
  sessionId: string,
  worktree: string,
): Promise<string | null> {
  const result = await runGit(sessionId, ['rev-parse', '--verify', 'HEAD'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

async function worktreeBranch(
  sessionId: string,
  worktree: string,
): Promise<string | null> {
  const result = await runGit(
    sessionId,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    { cwd: worktree, allowFailure: true },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

async function worktreeStatus(
  sessionId: string,
  worktree: string,
): Promise<string> {
  const result = await runGit(sessionId, ['status', '--short'], {
    cwd: worktree,
  });
  return result.stdout.trim();
}

async function worktreeOrigin(
  sessionId: string,
  worktree: string,
): Promise<string | null> {
  const result = await runGit(sessionId, ['remote', 'get-url', 'origin'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

function bundleFile(sessionId: string, kind: SourceKind, id: string): string {
  if (!isSafeEntityId(id)) throw new Error(`Invalid ${kind} id.`);
  const root = path.resolve(agentSessionDir(sessionId), 'bundles');
  const target = path.resolve(root, `${kind}-${id}.bundle`);
  if (!isWorkspacePathInside(root, target) || target === root) {
    throw new Error(`${kind} bundle path escapes its data root.`);
  }
  return target;
}

async function ensureBundleDirectory(
  sessionId: string,
  bundle: string,
): Promise<void> {
  prepareAgentSessionSandbox(sessionId);
  const directory = path.dirname(bundle);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Agent bundle path must be a real directory.');
  }
  await chmod(directory, 0o755);
  setRunnerOwned([directory]);
}

function defaultWorktreeDir(
  sessionId: string,
  kind: SourceKind,
  id: string,
): string {
  return kind === 'app'
    ? agentAppWorkDir(sessionId, id)
    : agentWorkflowWorkDir(sessionId, id);
}

function resolveWorktree(
  sessionId: string,
  kind: SourceKind,
  id: string,
  requestedPath?: string,
): Promise<AgentWorkspacePath> {
  return resolveAgentWorkspacePath(
    sessionId,
    requestedPath ?? defaultWorktreeDir(sessionId, kind, id),
  );
}

async function assertWorkspacePathAllowed(
  sessionId: string,
  worktree: string,
): Promise<void> {
  const target = path.resolve(worktree);
  const root = agentWorkDir(sessionId);
  const reservedRoots = [
    path.resolve(root, 'apps'),
    path.resolve(root, 'workflows'),
  ];
  if (reservedRoots.includes(target)) {
    throw new Error(
      `Workspace namespace cannot be used as a worktree: ${target}`,
    );
  }
  const attachments = path.resolve(root, 'attachments');
  if (isWorkspacePathInside(attachments, target)) {
    throw new Error(
      `Workspace path overlaps the attachment namespace: ${target}`,
    );
  }

  let parent = path.dirname(target);
  while (isWorkspacePathInside(root, parent) && parent !== root) {
    if (await pathExists(path.join(parent, '.git'))) {
      throw new Error(
        `Workspace path is nested inside another Git checkout: ${target}`,
      );
    }
    parent = path.dirname(parent);
  }
}

async function findNestedGitCheckout(root: string): Promise<string | null> {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;

  async function visit(
    directory: string,
    inspectDirectoryItself: boolean,
  ): Promise<string | null> {
    let originalMode: number | null = null;
    let entries;
    try {
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
        const stats = await lstat(directory);
        originalMode = stats.mode & 0o777;
        await chmod(directory, originalMode | 0o500);
        entries = await readdir(directory, { withFileTypes: true });
      }

      if (
        inspectDirectoryItself &&
        entries.some((entry) => entry.name === '.git')
      ) {
        return directory;
      }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.isSymbolicLink()) continue;
        const child = path.join(directory, entry.name);
        let stats;
        try {
          stats = await lstat(child);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
        const nested = await visit(child, true);
        if (nested) return nested;
      }
      return null;
    } finally {
      if (originalMode !== null) await chmod(directory, originalMode);
    }
  }

  return visit(root, false);
}

async function assertReplacementContainsNoNestedCheckout(
  replacementBackup: string,
  target: AgentWorkspacePath,
): Promise<void> {
  const nested = await findNestedGitCheckout(replacementBackup);
  if (!nested) return;
  const nestedRelativePath = path
    .relative(replacementBackup, nested)
    .split(path.sep)
    .join('/');
  const nestedDisplayPath = `${target.path}/${nestedRelativePath}`;
  throw new Error(
    `Refusing to replace checkout target "${target.path}" because it contains ` +
      `the nested Git checkout "${nestedDisplayPath}". Target the exact ` +
      'checkout you intend to replace; nested local work was preserved.',
  );
}

async function describeCheckout(
  sessionId: string,
  kind: SourceKind,
  id: string,
  worktree: string,
  remoteCommit: string | null,
  replacedExisting = false,
  synchronizedExisting = false,
): Promise<LocalCheckout> {
  const [status, headCommit] = await Promise.all([
    worktreeStatus(sessionId, worktree),
    worktreeHead(sessionId, worktree),
  ]);
  return {
    id,
    path: (await resolveWorktree(sessionId, kind, id, worktree)).path,
    absolutePath: worktree,
    dirty: status.length > 0,
    headCommit,
    remoteCommit,
    status,
    replacedExisting,
    synchronizedExisting,
  };
}

/**
 * Verify that an existing path is the checkout for this exact entity. The
 * origin URL -- our per-kind bundle path -- distinguishes app/workflow repos,
 * entities with different ids, and arbitrary Git repositories at custom paths.
 */
async function assertOwnedWorktree(
  sessionId: string,
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
  const origin = await worktreeOrigin(sessionId, worktree);
  if (!origin || path.resolve(origin) !== path.resolve(bundle)) {
    throw new Error(
      `Workspace path is not a checkout of ${kind} "${id}" ` +
        `(expected origin ${bundle}, found ${origin ?? 'no origin'}).`,
    );
  }
}

type PreparedCheckout = {
  root: string;
  worktree: string;
  bundle: string | null;
};

const CHECKOUT_CLEANUP_SCRIPT = String.raw`
import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

async function makeTreeRemovable(target) {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  await chmod(target, 0o700).catch(() => undefined);
  for (const name of await readdir(target)) {
    await makeTreeRemovable(path.join(target, name));
  }
}

const root = process.argv[1];
await makeTreeRemovable(root);
await rm(root, { recursive: true, force: true });
`;

function removePreparedCheckoutRootAsAgent(
  sessionId: string,
  root: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const wrapped = sandboxSpawn(
      [
        process.execPath,
        '--input-type=module',
        '--eval',
        CHECKOUT_CLEANUP_SCRIPT,
        root,
      ],
      sessionId,
    );
    const child = spawn(wrapped.command, wrapped.args, {
      env: {
        PATH: process.env.PATH,
        HOME: agentHomeDir(sessionId),
        LANG: process.env.LANG,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `Agent checkout cleanup exited with status ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
}

async function removePreparedCheckoutRoot(
  sessionId: string,
  root: string,
): Promise<void> {
  await removePreparedCheckoutRootAsAgent(sessionId, root);
}

async function cleanupPreparedCheckoutRoot(
  sessionId: string,
  root: string,
): Promise<void> {
  try {
    await removePreparedCheckoutRoot(sessionId, root);
  } catch (error) {
    console.warn(`Could not remove checkout staging directory ${root}:`, error);
  }
}

async function prepareCheckout(
  sessionId: string,
  source: SourceBundleResponse,
  finalBundle: string,
): Promise<PreparedCheckout> {
  if (Boolean(source.bundleBase64) !== Boolean(source.masterCommit)) {
    throw new Error('Platform source bundle and master commit do not match.');
  }

  prepareAgentSessionSandbox(sessionId);
  const root = await mkdtemp(path.join(agentWorkDir(sessionId), '.checkout-'));
  await chmod(root, 0o700);
  setAgentOwned([root], sessionId);
  const worktree = path.join(root, 'worktree');
  const bundle = source.bundleBase64 ? path.join(root, 'source.bundle') : null;
  try {
    if (bundle) {
      await writeFile(bundle, Buffer.from(source.bundleBase64!, 'base64'));
      await runGit(sessionId, ['clone', bundle, worktree]);
      await runGit(sessionId, ['remote', 'set-url', 'origin', finalBundle], {
        cwd: worktree,
      });
    } else {
      await runGit(sessionId, [
        'init',
        '--initial-branch',
        SOURCE_BRANCH,
        worktree,
      ]);
      await runGit(sessionId, ['remote', 'add', 'origin', finalBundle], {
        cwd: worktree,
      });
    }
    await setLocalGitIdentity(sessionId, worktree);

    const [head, status] = await Promise.all([
      worktreeHead(sessionId, worktree),
      worktreeStatus(sessionId, worktree),
    ]);
    if (head !== source.masterCommit) {
      throw new Error(
        `Prepared checkout HEAD ${head ?? 'none'} does not match platform ` +
          `master ${source.masterCommit ?? 'none'}.`,
      );
    }
    if (status) {
      throw new Error(`Prepared checkout is unexpectedly dirty:\n${status}`);
    }
    return { root, worktree, bundle };
  } catch (error) {
    await cleanupPreparedCheckoutRoot(sessionId, root);
    throw error;
  }
}

async function installPreparedBundle(
  prepared: PreparedCheckout,
  finalBundle: string,
): Promise<void> {
  const backup = path.join(prepared.root, 'previous.bundle');
  const hadBundle = await pathEntryExists(finalBundle);
  let installed = false;
  try {
    if (hadBundle) await rename(finalBundle, backup);
    if (prepared.bundle) {
      await rename(prepared.bundle, finalBundle);
      await chmod(finalBundle, 0o444);
      setRunnerOwned([finalBundle]);
      installed = true;
    }
  } catch (error) {
    if (installed) await rm(finalBundle, { force: true });
    if (hadBundle && (await pathEntryExists(backup))) {
      await rename(backup, finalBundle);
    }
    throw error;
  }
}

async function isCurrentOwnedWorktree(
  sessionId: string,
  worktree: string,
  bundle: string,
  source: SourceBundleResponse,
  kind: SourceKind,
): Promise<boolean> {
  try {
    await assertOwnedWorktree(sessionId, worktree, bundle, source.id, kind);
    return true;
  } catch {
    return false;
  }
}

function checkoutConflictMessage(
  kind: SourceKind,
  resolved: AgentWorkspacePath,
  source: SourceBundleResponse,
  originRefreshed: boolean,
): string {
  const tool = `checkout_${kind}`;
  const overwrite =
    `retry ${tool} as a fresh checkout at the same path with force: true to ` +
    'permanently ' +
    'discard that path and create a fresh checkout.';
  if (!originRefreshed) {
    return (
      `Checkout target "${resolved.path}" already exists. Nothing was ` +
      `changed. Reuse it, choose a different path, or ${overwrite}`
    );
  }
  if (!source.bundleBase64) {
    return (
      `Checkout target "${resolved.path}" already exists. The worktree was ` +
      'not overwritten; platform master is currently empty. ' +
      `Choose another path, or ${overwrite}`
    );
  }
  return (
    `Checkout target "${resolved.path}" already exists. The worktree was not ` +
    'overwritten, but its origin bundle was refreshed. Continue using ' +
    `${resolved.absolutePath} and run git fetch origin master to preserve ` +
    `local work, or ${overwrite}`
  );
}

function checkoutSynchronizationConflictMessage(
  kind: SourceKind,
  resolved: AgentWorkspacePath,
): string {
  const tool = `checkout_${kind}`;
  return (
    `Checkout target "${resolved.path}" could not be synchronized because ` +
    'local master has commits ahead of or diverged from platform master. Its ' +
    'origin/master was refreshed, but local master and the worktree were not ' +
    'changed. Rebase or merge the local commits onto origin/master, or retry ' +
    `${tool} as a fresh checkout at the same path with force: true to ` +
    'permanently discard that path.'
  );
}

function cloneTargetExistsMessage(
  kind: SourceKind,
  resolved: AgentWorkspacePath,
): string {
  return (
    `Cannot clone ${kind} into "${resolved.path}" because that path already ` +
    'exists. Update the existing checkout with its exact path, choose a new ' +
    'path, or use force: true to permanently replace that exact target.'
  );
}

async function synchronizeExistingCheckout(
  sessionId: string,
  kind: SourceKind,
  source: SourceBundleResponse,
  resolved: AgentWorkspacePath,
  materializer?: WorktreeMaterializer,
): Promise<LocalCheckout | null> {
  if (!source.bundleBase64 || !source.masterCommit) return null;

  const worktree = resolved.absolutePath;
  await prepareWorktreeMaterialization(worktree, materializer);
  const [branchBeforeFetch, statusBeforeFetch] = await Promise.all([
    worktreeBranch(sessionId, worktree),
    worktreeStatus(sessionId, worktree),
  ]);
  if (branchBeforeFetch !== SOURCE_BRANCH || statusBeforeFetch) return null;

  await runGit(sessionId, ['fetch', 'origin', SOURCE_BRANCH], {
    cwd: worktree,
  });
  const remoteRef = `origin/${SOURCE_BRANCH}`;
  const remoteHead = (
    await runGit(sessionId, ['rev-parse', '--verify', remoteRef], {
      cwd: worktree,
    })
  ).stdout.trim();
  if (remoteHead !== source.masterCommit) {
    throw new Error(
      `Fetched ${remoteRef} ${remoteHead || 'none'} does not match platform ` +
        `${SOURCE_BRANCH} ${source.masterCommit}.`,
    );
  }

  // Re-check after fetch so edits or branch switches made while it was running
  // are rejected before attempting the in-place fast-forward.
  const [branch, status, head] = await Promise.all([
    worktreeBranch(sessionId, worktree),
    worktreeStatus(sessionId, worktree),
    worktreeHead(sessionId, worktree),
  ]);
  if (branch !== SOURCE_BRANCH || status) return null;

  if (head) {
    const ancestor = await runGit(
      sessionId,
      ['merge-base', '--is-ancestor', head, remoteRef],
      { cwd: worktree, allowFailure: true },
    );
    if (ancestor.exitCode === 1) {
      throw new Error(checkoutSynchronizationConflictMessage(kind, resolved));
    }
    if (ancestor.exitCode !== 0) {
      const details = (ancestor.stderr || ancestor.stdout).trim();
      throw new Error(
        `git merge-base --is-ancestor ${head} ${remoteRef} failed: ${details}`,
      );
    }
  }

  // A fast-forward merge reaches the validated remote commit while refusing
  // to discard a concurrent commit or edit.
  await runGit(sessionId, ['merge', '--ff-only', remoteRef], {
    cwd: worktree,
  });
  const [branchAfterMerge, statusAfterMerge, headAfterMerge] =
    await Promise.all([
      worktreeBranch(sessionId, worktree),
      worktreeStatus(sessionId, worktree),
      worktreeHead(sessionId, worktree),
    ]);
  if (
    branchAfterMerge !== SOURCE_BRANCH ||
    statusAfterMerge ||
    headAfterMerge !== source.masterCommit
  ) {
    throw new Error(
      `Checkout target "${resolved.path}" changed while it was being ` +
        'synchronized. No local changes were discarded; inspect the worktree ' +
        'and retry checkout.',
    );
  }

  await materializeWorktree(worktree, materializer);
  setAgentOwned([worktree], sessionId);
  const [branchAfterMaterialize, checkout] = await Promise.all([
    worktreeBranch(sessionId, worktree),
    describeCheckout(
      sessionId,
      kind,
      source.id,
      worktree,
      source.masterCommit,
      false,
      true,
    ),
  ]);
  if (
    branchAfterMaterialize !== SOURCE_BRANCH ||
    checkout.dirty ||
    checkout.headCommit !== source.masterCommit
  ) {
    throw new Error(
      `Checkout target "${resolved.path}" changed while it was being ` +
        'synchronized. No local changes were discarded; inspect the worktree ' +
        'and retry checkout.',
    );
  }
  return checkout;
}

/** Materialize a fresh app/workflow checkout from the platform source bundle. */
export async function checkoutFromBundle(
  sessionId: string,
  kind: SourceKind,
  source: SourceBundleResponse,
  options: CheckoutFromBundleOptions = {},
): Promise<LocalCheckout> {
  const { id } = source;
  const mode = options.mode ?? 'upsert';
  if (mode === 'update' && !options.targetPath) {
    throw new Error(
      'An explicit source path is required to update a checkout.',
    );
  }
  if (mode === 'update' && options.force) {
    throw new Error('force cannot be used when updating an existing checkout.');
  }
  const resolved = await resolveWorktree(
    sessionId,
    kind,
    id,
    options.targetPath,
  );
  const worktree = resolved.absolutePath;
  await assertWorkspacePathAllowed(sessionId, worktree);
  const bundle = bundleFile(sessionId, kind, id);
  const worktreeExists = await pathEntryExists(worktree);
  const force = options.force ?? false;
  if (!worktreeExists && mode === 'update') {
    throw new Error(
      `Cannot update checkout "${resolved.path}" because it does not exist. ` +
        'Clone the app first or provide the path of an existing checkout.',
    );
  }
  if (worktreeExists && mode === 'clone' && !force) {
    throw new Error(cloneTargetExistsMessage(kind, resolved));
  }
  if (worktreeExists && !force) {
    let owned: boolean;
    if (mode === 'update') {
      await assertOwnedWorktree(sessionId, worktree, bundle, source.id, kind);
      owned = true;
    } else {
      owned = await isCurrentOwnedWorktree(
        sessionId,
        worktree,
        bundle,
        source,
        kind,
      );
    }
    if (owned) {
      await ensureBundleDirectory(sessionId, bundle);
      const prepared = await prepareCheckout(sessionId, source, bundle);
      try {
        await installPreparedBundle(prepared, bundle);
      } finally {
        await cleanupPreparedCheckoutRoot(sessionId, prepared.root);
      }
      const synchronized = await synchronizeExistingCheckout(
        sessionId,
        kind,
        source,
        resolved,
        options.materializer,
      );
      if (synchronized) return synchronized;
    }
    throw new Error(checkoutConflictMessage(kind, resolved, source, owned));
  }

  await ensureBundleDirectory(sessionId, bundle);
  const prepared = await prepareCheckout(sessionId, source, bundle);
  await mkdir(path.dirname(worktree), { recursive: true });
  setAgentOwned([agentWorkDir(sessionId)], sessionId);
  const worktreeBackup = path.join(prepared.root, 'previous-worktree');
  const bundleBackup = path.join(prepared.root, 'previous.bundle');
  const hadBundle = await pathEntryExists(bundle);
  let movedWorktree = false;
  let movedBundle = false;
  let installedWorktree = false;
  let installedBundle = false;
  let preservePreparedRoot = false;
  try {
    if (worktreeExists) {
      await rename(worktree, worktreeBackup);
      movedWorktree = true;
      await assertReplacementContainsNoNestedCheckout(worktreeBackup, resolved);
    }
    if (hadBundle) {
      await rename(bundle, bundleBackup);
      movedBundle = true;
    }
    if (prepared.bundle) {
      await rename(prepared.bundle, bundle);
      await chmod(bundle, 0o444);
      setRunnerOwned([bundle]);
      installedBundle = true;
    }
    await rename(prepared.worktree, worktree);
    installedWorktree = true;
    await materializeWorktree(worktree, options.materializer);
    setAgentOwned([worktree], sessionId);
    const checkout = await describeCheckout(
      sessionId,
      kind,
      id,
      worktree,
      source.masterCommit,
      worktreeExists,
    );
    return checkout;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (installedWorktree) {
        await rm(worktree, { recursive: true, force: true });
      }
      if (movedWorktree && (await pathEntryExists(worktreeBackup))) {
        await rename(worktreeBackup, worktree);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (installedBundle) await rm(bundle, { force: true });
      if (movedBundle && (await pathEntryExists(bundleBackup))) {
        await rename(bundleBackup, bundle);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      preservePreparedRoot = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Checkout replacement failed and could not be fully restored. ` +
          `Recovery files remain at ${prepared.root}.`,
      );
    }
    throw error;
  } finally {
    if (!preservePreparedRoot) {
      await cleanupPreparedCheckoutRoot(sessionId, prepared.root);
    }
  }
}

/**
 * Preflight for creating a new entity under a caller-chosen id: fail BEFORE
 * the platform registers the id when the local directory is already taken
 * (otherwise the create would leave an orphan draft row behind and retrying
 * the same id would hit "already exists" on the platform side).
 *
 * The directory may also be an old or manually relocated checkout left in the
 * conversation after an entity was deleted; tell the Agent how to resolve it.
 */
export async function assertWorktreeAvailable(
  sessionId: string,
  kind: SourceKind,
  id: string,
  targetPath?: string,
): Promise<AgentWorkspacePath> {
  const resolved = await resolveWorktree(sessionId, kind, id, targetPath);
  return assertResolvedWorktreeAvailable(sessionId, resolved);
}

/** Preflight a caller-provided create target before Platform state is mutated. */
export async function assertWorkspacePathAvailable(
  sessionId: string,
  targetPath: string,
): Promise<AgentWorkspacePath> {
  const resolved = await resolveAgentWorkspacePath(sessionId, targetPath);
  return assertResolvedWorktreeAvailable(sessionId, resolved);
}

async function assertResolvedWorktreeAvailable(
  sessionId: string,
  resolved: AgentWorkspacePath,
): Promise<AgentWorkspacePath> {
  await assertWorkspacePathAllowed(sessionId, resolved.absolutePath);
  if (await pathExists(resolved.absolutePath)) {
    const entries = await readdir(resolved.absolutePath);
    if (entries.length === 0) return resolved;
    throw new Error(
      `Workspace path already exists and is not empty: ${resolved.path}`,
    );
  }
  return resolved;
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
  targetPath?: string,
  materializer?: WorktreeMaterializer,
): Promise<LocalCheckout> {
  const resolved = await assertWorktreeAvailable(
    sessionId,
    kind,
    id,
    targetPath,
  );
  const worktree = resolved.absolutePath;
  const bundle = bundleFile(sessionId, kind, id);
  prepareAgentSessionSandbox(sessionId);
  await ensureBundleDirectory(sessionId, bundle);
  // A newly created entity has an empty canonical repo. Its reused id must not
  // expose a bundle left by an older incarnation through the new origin URL.
  await rm(bundle, { force: true });

  await mkdir(path.dirname(worktree), { recursive: true });
  setAgentOwned([agentWorkDir(sessionId)], sessionId);
  // Let (possibly UID-demoted) git create the worktree dir itself so the
  // repo's owner matches the uid git runs as (git's safe.directory check).
  await runGit(sessionId, [
    'init',
    '--initial-branch',
    SOURCE_BRANCH,
    worktree,
  ]);
  await runGit(sessionId, ['remote', 'add', 'origin', bundle], {
    cwd: worktree,
  });
  await setLocalGitIdentity(sessionId, worktree);
  await writeFiles(worktree);
  await materializeWorktree(worktree, materializer);
  setAgentOwned([worktree], sessionId);
  return describeCheckout(sessionId, kind, id, worktree, null);
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
  sourcePath: string,
): Promise<{ bundleBase64: string; headCommit: string }> {
  const worktree = (await resolveWorktree(sessionId, kind, id, sourcePath))
    .absolutePath;
  await assertWorkspacePathAllowed(sessionId, worktree);
  const bundle = bundleFile(sessionId, kind, id);
  if (!(await pathExists(worktree))) {
    throw new Error(
      `${kind} "${id}" is not checked out in this chat. Run checkout first.`,
    );
  }
  await assertOwnedWorktree(sessionId, worktree, bundle, id, kind);

  const status = await worktreeStatus(sessionId, worktree);
  if (status) {
    throw new Error(
      `Cannot deploy ${kind} "${id}" because the worktree is dirty.\n` +
        'Commit or discard these changes first:\n' +
        status,
    );
  }
  const headCommit = await worktreeHead(sessionId, worktree);
  if (!headCommit) {
    throw new Error(
      `Cannot deploy ${kind} "${id}" because the worktree has no ` +
        'commits yet. Run git add and git commit first.',
    );
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'hatch-runner-bundle-'));
  // mkdtemp creates 0700 dirs owned by the runner; the (possibly UID-demoted)
  // git below must be able to write the bundle into it.
  await chmod(tmp, 0o700);
  setAgentOwned([tmp], sessionId);
  const out = path.join(tmp, 'deploy.bundle');
  try {
    // --all + HEAD: self-contained bundle carrying every local ref, so the
    // platform can clone it and fast-forward its canonical master from HEAD.
    await runGit(sessionId, ['bundle', 'create', out, '--all', 'HEAD'], {
      cwd: worktree,
    });
    const data = await readFile(out);
    return { bundleBase64: data.toString('base64'), headCommit };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
