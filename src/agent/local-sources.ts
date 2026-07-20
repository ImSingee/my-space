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
 *   agents/<sessionId>/workspace-index.json         ← runner-private path index
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
  AGENT_HOME_DIR,
  agentAppWorkDir,
  agentSessionDir,
  agentWorkDir,
  agentWorkflowWorkDir,
  isSafeEntityId,
} from './paths';
import type { SourceBundleResponse } from './protocol';
import { sandboxSpawn } from './shell-sandbox';
import {
  isWorkspacePathInside,
  listIndexedWorkspaces,
  registerWorkspace,
  removeIndexedWorkspaces,
  type WorkspaceIndexEntry,
  workspacePathsOverlap,
} from './workspace-index';
import {
  resolveAgentWorkspacePath,
  type AgentWorkspacePath,
} from './workspace-paths';

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
};

const workspaceMutationChains = new Map<string, Promise<unknown>>();

type SourceGateWaiter = {
  mode: 'read' | 'write';
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const sourceGateQueue: SourceGateWaiter[] = [];
let sourceGateReaders = 0;
let sourceGateWriter = false;
const sourceBarrierToken = Symbol('source-workspace-barrier');
let activeSourceBarrier: symbol | null = null;

export type SourceWorkspaceBarrier = {
  readonly [sourceBarrierToken]: symbol;
  release(): void;
};

function drainSourceGate(): void {
  if (sourceGateWriter || sourceGateReaders > 0) return;
  const first = sourceGateQueue[0];
  if (!first) return;

  if (first.mode === 'write') {
    sourceGateQueue.shift();
    if (first.signal && first.onAbort) {
      first.signal.removeEventListener('abort', first.onAbort);
    }
    sourceGateWriter = true;
    let released = false;
    first.resolve(() => {
      if (released) return;
      released = true;
      sourceGateWriter = false;
      drainSourceGate();
    });
    return;
  }

  while (sourceGateQueue[0]?.mode === 'read') {
    const reader = sourceGateQueue.shift()!;
    if (reader.signal && reader.onAbort) {
      reader.signal.removeEventListener('abort', reader.onAbort);
    }
    sourceGateReaders += 1;
    let released = false;
    reader.resolve(() => {
      if (released) return;
      released = true;
      sourceGateReaders -= 1;
      drainSourceGate();
    });
  }
}

function acquireSourceGate(
  mode: 'read' | 'write',
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('Source workspace operation was aborted.'));
  }
  return new Promise((resolve, reject) => {
    const waiter: SourceGateWaiter = { mode, resolve, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = sourceGateQueue.indexOf(waiter);
        if (index < 0) return;
        sourceGateQueue.splice(index, 1);
        reject(new Error('Source workspace operation was aborted.'));
        drainSourceGate();
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    sourceGateQueue.push(waiter);
    drainSourceGate();
  });
}

export async function acquireSourceWorkspaceBarrier(): Promise<SourceWorkspaceBarrier> {
  const releaseGate = await acquireSourceGate('write');
  const token = Symbol('source-workspace-barrier-owner');
  activeSourceBarrier = token;
  let released = false;
  return {
    [sourceBarrierToken]: token,
    release: () => {
      if (released) return;
      released = true;
      if (activeSourceBarrier === token) activeSourceBarrier = null;
      releaseGate();
    },
  };
}

function assertActiveSourceBarrier(barrier: SourceWorkspaceBarrier): void {
  if (activeSourceBarrier !== barrier[sourceBarrierToken]) {
    throw new Error('Source workspace barrier is not active.');
  }
}

export async function withSourceWorkspaceLock<T>(
  sessionId: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const releaseGate = await acquireSourceGate('read', signal);
  try {
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
    return await result;
  } finally {
    releaseGate();
  }
}

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

async function worktreeBranch(worktree: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: worktree,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
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
  if (!isSafeEntityId(id)) throw new Error(`Invalid ${kind} id.`);
  const root = path.resolve(agentSessionDir(sessionId), 'bundles');
  const target = path.resolve(root, `${kind}-${id}.bundle`);
  if (!isWorkspacePathInside(root, target) || target === root) {
    throw new Error(`${kind} bundle path escapes its data root.`);
  }
  return target;
}

/** Remove one stale app/workflow incarnation from this session. */
export function removeSourceWorkspaces(
  sessionId: string,
  kind: SourceKind,
  id: string,
  generation: string | null,
): Promise<number> {
  return withSourceWorkspaceLock(sessionId, () =>
    removeSourceWorkspacesUnlocked(sessionId, kind, id, generation),
  );
}

/** Remove a stale hello-time source while the runner holds the exclusive gate. */
export function removeSourceWorkspacesUnderBarrier(
  barrier: SourceWorkspaceBarrier,
  sessionId: string,
  kind: SourceKind,
  id: string,
  generation: string | null,
): Promise<number> {
  assertActiveSourceBarrier(barrier);
  return removeSourceWorkspacesUnlocked(sessionId, kind, id, generation);
}

async function removeSourceWorkspacesUnlocked(
  sessionId: string,
  kind: SourceKind,
  id: string,
  generation: string | null,
): Promise<number> {
  const bundle = bundleFile(sessionId, kind, id);
  const allIndexed = await listIndexedWorkspaces(sessionId);
  const indexed = allIndexed.filter(
    (entry) =>
      entry.kind === kind &&
      entry.id === id &&
      generation !== null &&
      entry.generation === generation,
  );
  const remainingIndexed = allIndexed.filter(
    (entry) =>
      !(
        entry.kind === kind &&
        entry.id === id &&
        generation !== null &&
        entry.generation === generation
      ),
  );
  const fallbackCandidates = [
    defaultWorktreeDir(sessionId, kind, id),
    path.resolve(agentWorkDir(sessionId), id),
  ].filter(
    (candidate) =>
      !allIndexed.some(
        (entry) => path.resolve(entry.absolutePath) === path.resolve(candidate),
      ),
  );
  const candidates = new Set([
    ...fallbackCandidates,
    ...indexed.map((entry) => entry.absolutePath),
  ]);
  const removed = new Set<string>();
  for (const candidate of candidates) {
    let resolved: AgentWorkspacePath;
    try {
      resolved = await resolveAgentWorkspacePath(sessionId, candidate);
    } catch {
      continue;
    }
    if (!(await pathExists(path.join(resolved.absolutePath, '.git')))) continue;
    const origin = await worktreeOrigin(resolved.absolutePath);
    if (!origin || path.resolve(origin) !== path.resolve(bundle)) continue;
    const protectedPaths = remainingIndexed.map((entry) =>
      path.resolve(entry.absolutePath),
    );
    if (
      await removeTreePreservingPaths(resolved.absolutePath, protectedPaths)
    ) {
      removed.add(path.resolve(resolved.absolutePath));
    }
  }
  if (generation !== null) {
    // Paths whose origin changed are deliberately left on disk, but this stale
    // incarnation must no longer be authoritative in the private index.
    await removeIndexedWorkspaces(
      sessionId,
      (entry) =>
        entry.kind === kind &&
        entry.id === id &&
        entry.generation === generation,
    );
  }
  const hasOtherGeneration = remainingIndexed.some(
    (entry) => entry.kind === kind && entry.id === id,
  );
  if (!hasOtherGeneration) await rm(bundle, { force: true });
  return removed.size;
}

async function removeTreePreservingPaths(
  target: string,
  protectedPaths: string[],
): Promise<boolean> {
  const absolute = path.resolve(target);
  if (
    protectedPaths.some((candidate) => path.resolve(candidate) === absolute)
  ) {
    return false;
  }
  const nested = protectedPaths.filter((candidate) =>
    isWorkspacePathInside(absolute, candidate),
  );
  if (nested.length === 0) {
    await rm(absolute, { recursive: true, force: true });
    return true;
  }
  for (const name of await readdir(absolute)) {
    await removeTreePreservingPaths(path.join(absolute, name), nested);
  }
  return true;
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

async function assertWorkspaceDoesNotOverlap(
  sessionId: string,
  worktree: string,
  options: {
    allowedExact?: { kind: SourceKind; id: string };
    allowAnyExact?: boolean;
  } = {},
): Promise<WorkspaceIndexEntry | undefined> {
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

  const entries = await listIndexedWorkspaces(sessionId);
  const conflict = entries.find((entry) => {
    const samePath = path.resolve(entry.absolutePath) === target;
    const exactAllowed =
      samePath &&
      (options.allowAnyExact ||
        (options.allowedExact?.kind === entry.kind &&
          options.allowedExact.id === entry.id));
    return !exactAllowed && workspacePathsOverlap(entry.absolutePath, target);
  });
  if (conflict) {
    throw new Error(
      `Workspace path ${target} overlaps the registered ${conflict.kind} ` +
        `"${conflict.id}" checkout at ${conflict.absolutePath}.`,
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
  return entries.find((entry) => path.resolve(entry.absolutePath) === target);
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
    worktreeStatus(worktree),
    worktreeHead(worktree),
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
  if (!origin || path.resolve(origin) !== path.resolve(bundle)) {
    throw new Error(
      `Workspace path is not a checkout of ${kind} "${id}" ` +
        `(expected origin ${bundle}, found ${origin ?? 'no origin'}).`,
    );
  }
}

async function assertWorkspaceGeneration(
  sessionId: string,
  worktree: string,
  kind: SourceKind,
  id: string,
  generation: string,
): Promise<void> {
  const exact = (await listIndexedWorkspaces(sessionId)).find(
    (entry) =>
      entry.kind === kind &&
      entry.id === id &&
      path.resolve(entry.absolutePath) === path.resolve(worktree),
  );
  if (!exact || exact.generation === generation) return;
  throw new Error(
    `The worktree at ${worktree} belongs to a previous incarnation of ${kind} ` +
      `"${id}". Remove that exact path and run checkout again.`,
  );
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

function removePreparedCheckoutRootAsAgent(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const wrapped = sandboxSpawn([
      process.execPath,
      '--input-type=module',
      '--eval',
      CHECKOUT_CLEANUP_SCRIPT,
      root,
    ]);
    const child = spawn(wrapped.command, wrapped.args, {
      env: {
        PATH: process.env.PATH,
        HOME: AGENT_HOME_DIR,
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

async function removePreparedCheckoutRoot(root: string): Promise<void> {
  await removePreparedCheckoutRootAsAgent(root);
}

async function cleanupPreparedCheckoutRoot(root: string): Promise<void> {
  try {
    await removePreparedCheckoutRoot(root);
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

  await mkdir(agentSessionDir(sessionId), { recursive: true });
  const root = await mkdtemp(
    path.join(agentSessionDir(sessionId), '.checkout-'),
  );
  await chmod(root, 0o777);
  const worktree = path.join(root, 'worktree');
  const bundle = source.bundleBase64 ? path.join(root, 'source.bundle') : null;
  try {
    if (bundle) {
      await writeFile(bundle, Buffer.from(source.bundleBase64!, 'base64'));
      await runGit(['clone', bundle, worktree]);
      await runGit(['remote', 'set-url', 'origin', finalBundle], {
        cwd: worktree,
      });
    } else {
      await runGit(['init', '--initial-branch', SOURCE_BRANCH, worktree]);
      await runGit(['remote', 'add', 'origin', finalBundle], { cwd: worktree });
    }
    await setLocalGitIdentity(worktree);

    const [head, status] = await Promise.all([
      worktreeHead(worktree),
      worktreeStatus(worktree),
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
    await cleanupPreparedCheckoutRoot(root);
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
    await assertOwnedWorktree(worktree, bundle, source.id, kind);
    await assertWorkspaceGeneration(
      sessionId,
      worktree,
      kind,
      source.id,
      source.generation,
    );
    return true;
  } catch {
    return false;
  }
}

async function hasOtherOwnedDefaultCheckout(
  sessionId: string,
  owner: WorkspaceIndexEntry,
  excludedPath: string,
): Promise<boolean> {
  let defaultPath: string;
  try {
    defaultPath = (await resolveWorktree(sessionId, owner.kind, owner.id))
      .absolutePath;
  } catch {
    return false;
  }
  if (path.resolve(defaultPath) === path.resolve(excludedPath)) return false;
  if (!(await pathExists(path.join(defaultPath, '.git')))) return false;
  const origin = await worktreeOrigin(defaultPath);
  return (
    origin !== null &&
    path.resolve(origin) ===
      path.resolve(bundleFile(sessionId, owner.kind, owner.id))
  );
}

function checkoutConflictMessage(
  kind: SourceKind,
  resolved: AgentWorkspacePath,
  source: SourceBundleResponse,
  originRefreshed: boolean,
): string {
  const tool = `checkout_${kind}`;
  const overwrite =
    `retry ${tool} with the same target_path and force: true to permanently ` +
    'discard that path and create a fresh checkout.';
  if (!originRefreshed) {
    return (
      `Checkout target "${resolved.path}" already exists. Nothing was ` +
      `changed. Reuse it, choose a different target_path, or ${overwrite}`
    );
  }
  if (!source.bundleBase64) {
    return (
      `Checkout target "${resolved.path}" already exists. The worktree was ` +
      'not overwritten; platform master is currently empty. ' +
      `Choose another target_path, or ${overwrite}`
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
    `${tool} with the same target_path and force: true to permanently discard ` +
    'that path and create a fresh checkout.'
  );
}

async function synchronizeExistingCheckout(
  sessionId: string,
  kind: SourceKind,
  source: SourceBundleResponse,
  resolved: AgentWorkspacePath,
): Promise<LocalCheckout | null> {
  if (!source.bundleBase64 || !source.masterCommit) return null;

  const worktree = resolved.absolutePath;
  const [branchBeforeFetch, statusBeforeFetch] = await Promise.all([
    worktreeBranch(worktree),
    worktreeStatus(worktree),
  ]);
  if (branchBeforeFetch !== SOURCE_BRANCH || statusBeforeFetch) return null;

  await runGit(['fetch', 'origin', SOURCE_BRANCH], { cwd: worktree });
  const remoteRef = `origin/${SOURCE_BRANCH}`;
  const remoteHead = (
    await runGit(['rev-parse', '--verify', remoteRef], { cwd: worktree })
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
    worktreeBranch(worktree),
    worktreeStatus(worktree),
    worktreeHead(worktree),
  ]);
  if (branch !== SOURCE_BRANCH || status) return null;

  if (head) {
    const ancestor = await runGit(
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
  await runGit(['merge', '--ff-only', remoteRef], { cwd: worktree });
  const [branchAfterMerge, checkout] = await Promise.all([
    worktreeBranch(worktree),
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
    branchAfterMerge !== SOURCE_BRANCH ||
    checkout.dirty ||
    checkout.headCommit !== source.masterCommit
  ) {
    throw new Error(
      `Checkout target "${resolved.path}" changed while it was being ` +
        'synchronized. No local changes were discarded; inspect the worktree ' +
        'and retry checkout.',
    );
  }
  await registerWorkspace(
    sessionId,
    {
      kind,
      id: source.id,
      generation: source.generation,
      absolutePath: worktree,
    },
    { replaceExactPath: true },
  );
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
  const resolved = await resolveWorktree(
    sessionId,
    kind,
    id,
    options.targetPath,
  );
  const worktree = resolved.absolutePath;
  const previousOwner = await assertWorkspaceDoesNotOverlap(
    sessionId,
    worktree,
    {
      allowAnyExact: true,
    },
  );
  const bundle = bundleFile(sessionId, kind, id);
  const worktreeExists = await pathEntryExists(worktree);
  const force = options.force ?? false;
  if (worktreeExists && !force) {
    const owned = await isCurrentOwnedWorktree(
      sessionId,
      worktree,
      bundle,
      source,
      kind,
    );
    if (owned) {
      await mkdir(path.dirname(bundle), { recursive: true });
      const prepared = await prepareCheckout(sessionId, source, bundle);
      try {
        await installPreparedBundle(prepared, bundle);
      } finally {
        await cleanupPreparedCheckoutRoot(prepared.root);
      }
      const synchronized = await synchronizeExistingCheckout(
        sessionId,
        kind,
        source,
        resolved,
      );
      if (synchronized) return synchronized;
    }
    throw new Error(checkoutConflictMessage(kind, resolved, source, owned));
  }

  await mkdir(path.dirname(bundle), { recursive: true });
  const prepared = await prepareCheckout(sessionId, source, bundle);
  await mkdir(path.dirname(worktree), { recursive: true });
  const worktreeBackup = path.join(prepared.root, 'previous-worktree');
  const bundleBackup = path.join(prepared.root, 'previous.bundle');
  const previousOwnerBundleBackup = path.join(
    prepared.root,
    'previous-owner.bundle',
  );
  const hadBundle = await pathEntryExists(bundle);
  const previousOwnerHasOtherCheckouts = previousOwner
    ? (await listIndexedWorkspaces(sessionId)).some(
        (entry) =>
          entry.kind === previousOwner.kind &&
          entry.id === previousOwner.id &&
          path.resolve(entry.absolutePath) !== path.resolve(worktree),
      )
    : false;
  const previousOwnerHasDefaultCheckout =
    previousOwner && !previousOwnerHasOtherCheckouts
      ? await hasOtherOwnedDefaultCheckout(sessionId, previousOwner, worktree)
      : false;
  const previousOwnerBundle =
    previousOwner &&
    !previousOwnerHasOtherCheckouts &&
    !previousOwnerHasDefaultCheckout &&
    (previousOwner.kind !== kind || previousOwner.id !== id)
      ? bundleFile(sessionId, previousOwner.kind, previousOwner.id)
      : null;
  const hadPreviousOwnerBundle = previousOwnerBundle
    ? await pathEntryExists(previousOwnerBundle)
    : false;
  let movedWorktree = false;
  let movedBundle = false;
  let movedPreviousOwnerBundle = false;
  let installedWorktree = false;
  let installedBundle = false;
  let preservePreparedRoot = false;
  try {
    if (worktreeExists) {
      await rename(worktree, worktreeBackup);
      movedWorktree = true;
    }
    if (hadBundle) {
      await rename(bundle, bundleBackup);
      movedBundle = true;
    }
    if (previousOwnerBundle && hadPreviousOwnerBundle) {
      await rename(previousOwnerBundle, previousOwnerBundleBackup);
      movedPreviousOwnerBundle = true;
    }
    if (prepared.bundle) {
      await rename(prepared.bundle, bundle);
      installedBundle = true;
    }
    await rename(prepared.worktree, worktree);
    installedWorktree = true;
    const checkout = await describeCheckout(
      sessionId,
      kind,
      id,
      worktree,
      source.masterCommit,
      worktreeExists,
    );
    await registerWorkspace(
      sessionId,
      {
        kind,
        id,
        generation: source.generation,
        absolutePath: worktree,
      },
      { replaceExactPath: true },
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
    try {
      if (
        previousOwnerBundle &&
        movedPreviousOwnerBundle &&
        (await pathEntryExists(previousOwnerBundleBackup))
      ) {
        await rename(previousOwnerBundleBackup, previousOwnerBundle);
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
      await cleanupPreparedCheckoutRoot(prepared.root);
    }
  }
}

/**
 * Preflight for creating a new entity under a caller-chosen id: fail BEFORE
 * the platform registers the id when the local directory is already taken
 * (otherwise the create would leave an orphan draft row behind and retrying
 * the same id would hit "already exists" on the platform side).
 *
 * The directory may also be an old or manually relocated checkout that was not
 * registered when an entity was deleted; tell the Agent how to resolve it.
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
  await assertWorkspaceDoesNotOverlap(sessionId, resolved.absolutePath);
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
  generation: string,
  writeFiles: (root: string) => Promise<void>,
  targetPath?: string,
): Promise<LocalCheckout> {
  const resolved = await assertWorktreeAvailable(
    sessionId,
    kind,
    id,
    targetPath,
  );
  const worktree = resolved.absolutePath;
  const bundle = bundleFile(sessionId, kind, id);
  await mkdir(path.dirname(bundle), { recursive: true });
  // A newly created entity has an empty canonical repo. Its reused id must not
  // expose a bundle left by an older incarnation through the new origin URL.
  await rm(bundle, { force: true });

  await mkdir(path.dirname(worktree), { recursive: true });
  // Let (possibly UID-demoted) git create the worktree dir itself so the
  // repo's owner matches the uid git runs as (git's safe.directory check).
  await runGit(['init', '--initial-branch', SOURCE_BRANCH, worktree]);
  await runGit(['remote', 'add', 'origin', bundle], { cwd: worktree });
  await setLocalGitIdentity(worktree);
  await writeFiles(worktree);
  await registerWorkspace(sessionId, {
    kind,
    id,
    generation,
    absolutePath: worktree,
  });
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
  generation: string,
  sourcePath: string,
): Promise<{ bundleBase64: string; headCommit: string }> {
  const worktree = (await resolveWorktree(sessionId, kind, id, sourcePath))
    .absolutePath;
  await assertWorkspaceDoesNotOverlap(sessionId, worktree, {
    allowedExact: { kind, id },
  });
  const bundle = bundleFile(sessionId, kind, id);
  if (!(await pathExists(worktree))) {
    throw new Error(
      `${kind} "${id}" is not checked out in this chat. Run checkout first.`,
    );
  }
  await assertOwnedWorktree(worktree, bundle, id, kind);
  await assertWorkspaceGeneration(sessionId, worktree, kind, id, generation);

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
    await registerWorkspace(sessionId, {
      kind,
      id,
      generation,
      absolutePath: worktree,
    });
    return { bundleBase64: data.toString('base64'), headCommit };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
