/** Prepare generated/dependency files in an Agent App worktree. */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type DenoDependencySourceFile,
  validateDenoDependencySource,
} from '../deno-dependencies';
import {
  APP_MANAGED_DIR,
  isAppManagedPathSegment,
  isAppRegistryConfigName,
  isUnsupportedAppRootConfigName,
} from '../app-managed-path';
import { PLATFORM_APP_BUF_GEN_YAML } from './app-codegen';
import {
  isAgentAuthoredRoot,
  preflightAgentAuthoredSource,
  readAgentAuthoredFile,
} from './app-file-read';
import { WORKSPACE_ROOT } from './paths';
import { agentShellEnv, PLATFORM_NODE_BIN_DIR } from './shell-env';
import { resolveAgentOwnershipSession, sandboxSpawn } from './shell-sandbox';

const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
const PREPARE_OUTPUT_LIMIT = 1_000_000;
const GENERATED_ROOTS = new Set(['.hatch', 'gen', 'node_modules']);
const AUTHORED_SCAN_EXCLUSIONS = new Set(['.git', ...GENERATED_ROOTS]);
const REQUIRED_GENERATED_ROOTS = new Set(['.hatch']);

export type AppPreparationOptions = {
  /** Test seam; production preparation uses the five-minute default. */
  timeoutMs?: number;
};

export type AppPreparationStage =
  | 'source preflight'
  | 'dependency install'
  | 'Connect codegen';

export class AppPreparationError extends Error {
  constructor(
    readonly stage: AppPreparationStage,
    message: string,
  ) {
    super(`App preparation failed during ${stage}: ${message}`);
    this.name = 'AppPreparationError';
  }
}

function appendCapped(value: string, chunk: string): string {
  if (value.length >= PREPARE_OUTPUT_LIMIT) return value;
  const next = value + chunk;
  return next.length <= PREPARE_OUTPUT_LIMIT
    ? next
    : `${next.slice(0, PREPARE_OUTPUT_LIMIT)}\n…output truncated…`;
}

async function runPreparationCommand(
  root: string,
  stage: AppPreparationStage,
  argv: [string, ...string[]],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new AppPreparationError(stage, 'operation was aborted.');
  }

  const wrapped = sandboxSpawn(argv, resolveAgentOwnershipSession([root]));

  const killProcessTree = (pid: number | undefined) => {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        });
      } catch {
        // Best effort: the process may already be gone.
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Best effort: the process may already be gone.
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: root,
      detached: process.platform !== 'win32',
      env: {
        ...env,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const fail = (reason: string) =>
      finish(new AppPreparationError(stage, reason));
    const onAbort = () => {
      killProcessTree(child.pid);
      fail('operation was aborted.');
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      fail(`command timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      output = appendCapped(output, chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = appendCapped(output, chunk.toString());
    });
    child.on('exit', () => {
      if (process.platform === 'win32' || !child.pid) return;
      // A surviving descendant keeps the original process group id. Targeting
      // only that group avoids the direct-pid fallback (and its PID-reuse race)
      // after the group leader has exited.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // No descendants remain in the command's process group.
      }
    });
    child.on('error', (error) => fail(error.message));
    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      fail(
        `${argv[0]} exited with status ${code ?? 'unknown'}${
          output.trim() ? `:\n${output.trim()}` : '.'
        }`,
      );
    });
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function trustedPreparationEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const env = agentShellEnv(resolveAgentOwnershipSession([root]));
  const canonicalRoot = await realpath(root);
  let canonicalWorkspaceRoot = WORKSPACE_ROOT;
  try {
    canonicalWorkspaceRoot = await realpath(WORKSPACE_ROOT);
  } catch {
    // The workspace may not exist in isolated preparation tests.
  }
  const trusted: string[] = [];
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    try {
      const resolved = await realpath(entry);
      const info = await lstat(resolved);
      if (
        info.isDirectory() &&
        !isInside(canonicalRoot, resolved) &&
        !isInside(canonicalWorkspaceRoot, resolved)
      ) {
        trusted.push(resolved);
      }
    } catch {
      // Ignore missing and non-canonical PATH entries.
    }
  }
  env.PATH = [...new Set(trusted)].join(path.delimiter);
  return env;
}

async function resolveTrustedExecutable(
  root: string,
  executable: string,
  searchPath: string,
  stage: AppPreparationStage,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  let canonicalWorkspaceRoot = WORKSPACE_ROOT;
  try {
    canonicalWorkspaceRoot = await realpath(WORKSPACE_ROOT);
  } catch {
    // The workspace may not exist in isolated preparation tests.
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try {
      const resolvedDirectory = await realpath(directory);
      if (
        isInside(canonicalRoot, resolvedDirectory) ||
        isInside(canonicalWorkspaceRoot, resolvedDirectory)
      ) {
        continue;
      }
      const candidate = path.join(resolvedDirectory, executable);
      await access(candidate, fsConstants.X_OK);
      const resolved = await realpath(candidate);
      if (
        !isInside(canonicalRoot, resolved) &&
        !isInside(canonicalWorkspaceRoot, resolved)
      ) {
        return resolved;
      }
    } catch {
      // Continue searching trusted runner directories.
    }
  }
  throw new AppPreparationError(
    stage,
    `trusted ${executable} executable is unavailable.`,
  );
}

async function platformBufExecutable(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  let canonicalWorkspaceRoot = WORKSPACE_ROOT;
  try {
    canonicalWorkspaceRoot = await realpath(WORKSPACE_ROOT);
  } catch {
    // The workspace may not exist in isolated preparation tests.
  }
  const candidate = path.join(PLATFORM_NODE_BIN_DIR, 'buf');
  try {
    await access(candidate, fsConstants.X_OK);
    const resolved = await realpath(candidate);
    if (
      !isInside(canonicalRoot, resolved) &&
      !isInside(canonicalWorkspaceRoot, resolved)
    ) {
      return resolved;
    }
  } catch {
    // Report a preparation-stage error below.
  }
  throw new AppPreparationError(
    'Connect codegen',
    `trusted buf executable is unavailable at ${candidate}.`,
  );
}

async function assertAuthoredSourceHasNoSymlinks(
  root: string,
  relative = '',
): Promise<void> {
  const current = relative ? path.join(root, relative) : root;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (!relative && isAppRegistryConfigName(entry.name)) {
      throw new AppPreparationError(
        'source preflight',
        `source must not contain the platform-managed npm registry config: ${entry.name}.`,
      );
    }
    if (!relative && isUnsupportedAppRootConfigName(entry.name)) {
      throw new AppPreparationError(
        'source preflight',
        `source must not contain unsupported App config: ${entry.name}.`,
      );
    }
    if (isAppManagedPathSegment(entry.name)) {
      if (!relative && entry.name === APP_MANAGED_DIR) continue;
      const reservedPath = relative
        ? path.join(relative, entry.name)
        : entry.name;
      throw new AppPreparationError(
        'source preflight',
        `source must not contain the reserved .hatch path: ${reservedPath
          .split(path.sep)
          .join('/')}.`,
      );
    }
    if (!relative && AUTHORED_SCAN_EXCLUSIONS.has(entry.name)) continue;
    const childRelative = relative
      ? path.join(relative, entry.name)
      : entry.name;
    const child = path.join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) {
      throw new AppPreparationError(
        'source preflight',
        `source must not contain symbolic links: ${childRelative.split(path.sep).join('/')}.`,
      );
    }
    if (stat.isDirectory()) {
      await assertAuthoredSourceHasNoSymlinks(root, childRelative);
    }
  }
}

async function assertManagedRootUsesCanonicalCasing(
  root: string,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isAppManagedPathSegment(entry.name) && entry.name !== APP_MANAGED_DIR) {
      throw new AppPreparationError(
        'source preflight',
        `source must not contain a case variant of the reserved .hatch path: ${entry.name}.`,
      );
    }
  }
}

async function assertGeneratedRootsSafe(root: string): Promise<void> {
  for (const name of GENERATED_ROOTS) {
    const target = path.join(root, name);
    let entry;
    try {
      entry = await lstat(target);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !REQUIRED_GENERATED_ROOTS.has(name)
      ) {
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppPreparationError(
          'source preflight',
          `${name} must be materialized as a real directory before preparation.`,
        );
      }
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new AppPreparationError(
        'source preflight',
        `${name} must be a real directory.`,
      );
    }
  }
}

async function assertSourcePreflightSafe(root: string): Promise<void> {
  if (!isAgentAuthoredRoot(root)) {
    await assertManagedRootUsesCanonicalCasing(root);
    await assertGeneratedRootsSafe(root);
    await assertAuthoredSourceHasNoSymlinks(root);
    return;
  }
  const result = await preflightAgentAuthoredSource(
    root,
    [...GENERATED_ROOTS],
    [...REQUIRED_GENERATED_ROOTS],
    [...AUTHORED_SCAN_EXCLUSIONS],
  );
  if (result.ok) return;
  if (result.reason === 'generated_missing') {
    throw new AppPreparationError(
      'source preflight',
      `${result.path} must be materialized as a real directory before preparation.`,
    );
  }
  if (result.reason === 'generated_invalid') {
    throw new AppPreparationError(
      'source preflight',
      `${result.path} must be a real directory.`,
    );
  }
  if (result.reason === 'registry_config') {
    throw new AppPreparationError(
      'source preflight',
      `source must not contain the platform-managed npm registry config: ${result.path}.`,
    );
  }
  if (result.reason === 'unsupported_config') {
    throw new AppPreparationError(
      'source preflight',
      `source must not contain unsupported App config: ${result.path}.`,
    );
  }
  if (result.reason === 'reserved_path') {
    throw new AppPreparationError(
      'source preflight',
      `source must not contain a case variant or nested use of the reserved .hatch path: ${result.path}.`,
    );
  }
  throw new AppPreparationError(
    'source preflight',
    `source must not contain symbolic links: ${result.path}.`,
  );
}

async function readPreparationFile(
  root: string,
  file: string,
): Promise<string | null> {
  if (!isAgentAuthoredRoot(root)) {
    try {
      return await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  const result = await readAgentAuthoredFile(root, [file]);
  if ('content' in result) return result.content;
  if (result.error === 'missing') return null;
  if (result.error === 'symlink') {
    throw new Error(`${file} must not be a symbolic link.`);
  }
  throw new Error(`${file} must be a regular file.`);
}

async function appUsesRpc(root: string): Promise<boolean> {
  let parsed: unknown;
  try {
    const source = await readPreparationFile(root, 'manifest.json');
    if (source === null) throw new Error('manifest.json does not exist.');
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AppPreparationError(
      'source preflight',
      `cannot read manifest.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppPreparationError(
      'source preflight',
      'manifest.json must contain a JSON object.',
    );
  }
  const rpc = (parsed as Record<string, unknown>).rpc;
  if (rpc === undefined || rpc === null) return false;
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
    throw new AppPreparationError(
      'source preflight',
      'manifest.json rpc must contain an object.',
    );
  }
  return true;
}

async function resetGeneratedDirectory(
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const helper = String.raw`
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
const [root, expectedRoot] = process.argv.slice(1);
if (await realpath('.') !== expectedRoot || await realpath(root) !== expectedRoot) {
  throw new Error('App source root changed while resetting generated files.');
}
const entry = await lstat(root);
if (entry.isSymbolicLink() || !entry.isDirectory()) {
  throw new Error('App source root must be a real directory.');
}
const gen = path.join(root, 'gen');
try {
  const generated = await lstat(gen);
  if (generated.isSymbolicLink() || !generated.isDirectory()) {
    throw new Error('gen must be a real directory.');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await rm(gen, { recursive: true, force: true });
await mkdir(gen, { mode: 0o755 });
`;
  const canonicalRoot = await realpath(root);
  await runPreparationCommand(
    canonicalRoot,
    'Connect codegen',
    [
      await realpath(process.execPath),
      '--input-type=module',
      '--eval',
      helper,
      canonicalRoot,
      canonicalRoot,
    ],
    env,
    timeoutMs,
    signal,
  );
}

/**
 * Reproduce locked npm dependencies and generated Connect stubs without
 * changing authored files. The trusted inline template prevents an App's
 * buf.gen.yaml from selecting an arbitrary local plugin.
 */
export async function prepareAppWorktree(
  root: string,
  signal?: AbortSignal,
  options: AppPreparationOptions = {},
): Promise<void> {
  await assertSourcePreflightSafe(root);
  try {
    await validateDenoDependencySource(
      root,
      'app',
      isAgentAuthoredRoot(root)
        ? (file: DenoDependencySourceFile) => readPreparationFile(root, file)
        : undefined,
    );
  } catch (error) {
    throw new AppPreparationError(
      'source preflight',
      error instanceof Error ? error.message : String(error),
    );
  }
  const usesRpc = await appUsesRpc(root);
  const env = await trustedPreparationEnv(root);
  const timeoutMs = options.timeoutMs ?? PREPARE_TIMEOUT_MS;
  const deno = await resolveTrustedExecutable(
    root,
    'deno',
    env.PATH ?? '',
    'dependency install',
  );
  await runPreparationCommand(
    root,
    'dependency install',
    [
      deno,
      'install',
      '--no-config',
      '--package-json',
      '--node-modules-dir=auto',
      '--lock=deno.lock',
      '--frozen',
    ],
    env,
    timeoutMs,
    signal,
  );
  if (!usesRpc) {
    // The preflight proved this entry is absent or a real directory. Keep the
    // ignored generated state aligned with a deploy's clean temporary copy
    // when an App removes its RPC declaration.
    await resetGeneratedDirectory(root, env, timeoutMs, signal);
    return;
  }
  const buf = await platformBufExecutable(root);
  await runPreparationCommand(
    root,
    'Connect codegen',
    [buf, 'generate', '--template', PLATFORM_APP_BUF_GEN_YAML],
    env,
    timeoutMs,
    signal,
  );
}
