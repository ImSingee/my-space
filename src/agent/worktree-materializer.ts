import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS_DIR } from './paths';
import { resolveAgentOwnershipSession, sandboxSpawn } from './shell-sandbox';

export type WorktreeMaterializer = {
  gitExcludePatterns?: readonly string[];
  materialize(root: string): Promise<void>;
};

export class WorktreeMaterializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorktreeMaterializationError';
  }
}

function materializationError(reason: string, cause?: unknown): Error {
  return new WorktreeMaterializationError(
    `Cannot prepare generated worktree files: ${reason}.`,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeMaterializationError(error: unknown): Error {
  if (error instanceof WorktreeMaterializationError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return materializationError(reason, error);
}

async function requireDirectory(target: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await mkdir(target);
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw mkdirError;
      }
    }
    entry = await lstat(target);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw materializationError(`${label} must be a real directory`);
  }
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

async function agentWorktreeRoot(root: string): Promise<string | null> {
  // The lexical namespace decides authority. If an Agent races a path below
  // AGENTS_DIR into a symlink escape, the mutation must still stay demoted.
  if (!isInside(AGENTS_DIR, path.resolve(root))) return null;
  const [resolved, canonicalAgents] = await Promise.all([
    realpath(root),
    realpath(AGENTS_DIR),
  ]);
  if (!isInside(canonicalAgents, resolved)) {
    throw materializationError(
      'Agent worktree root escapes the Agent namespace through a symbolic link',
    );
  }
  return resolved;
}

function ensureAgentGitExcludes(
  root: string,
  patterns: readonly string[],
): Promise<void> {
  const helper = String.raw`
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const [root, expectedRoot, encodedPatterns] = process.argv.slice(1);
const patterns = JSON.parse(Buffer.from(encodedPatterns, 'base64url').toString());
if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((pattern) =>
  typeof pattern !== 'string' || !pattern || /[\r\n]/.test(pattern))) {
  throw new Error('Git exclude patterns must be non-empty single lines.');
}
if (await realpath('.') !== expectedRoot || await realpath(root) !== expectedRoot) {
  throw new Error('Worktree root changed while preparing Git excludes.');
}
const git = path.join(root, '.git');
const gitEntry = await lstat(git);
if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
  throw new Error('.git must be a real directory.');
}
const info = path.join(git, 'info');
try {
  await mkdir(info);
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
const infoEntry = await lstat(info);
if (infoEntry.isSymbolicLink() || !infoEntry.isDirectory()) {
  throw new Error('.git/info must be a real directory.');
}
const exclude = path.join(info, 'exclude');
let handle;
try {
  handle = await open(
    exclude,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND |
      constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
} catch (error) {
  if (error?.code === 'ELOOP') {
    throw new Error('.git/info/exclude must not be a symbolic link.');
  }
  throw error;
}
try {
  if (!(await handle.stat()).isFile()) {
    throw new Error('.git/info/exclude must be a regular file.');
  }
  const existing = await handle.readFile('utf8');
  const present = new Set(existing.split(/\r?\n/));
  const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern));
  if (missing.length > 0) {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await handle.write(prefix + missing.join('\n') + '\n');
  }
} finally {
  await handle.close();
}
`;
  const wrapped = sandboxSpawn(
    [
      process.execPath,
      '--input-type=module',
      '--eval',
      helper,
      root,
      root,
      Buffer.from(JSON.stringify(patterns)).toString('base64url'),
    ],
    resolveAgentOwnershipSession([root]),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            stderr.trim() ||
              `Sandboxed Git exclude update exited with status ${code ?? 'unknown'}.`,
          ),
        );
      }
    });
  });
}

async function ensureLocalGitExcludes(
  root: string,
  patterns: readonly string[],
): Promise<void> {
  const uniquePatterns = [...new Set(patterns)];
  if (uniquePatterns.length === 0) return;
  for (const pattern of uniquePatterns) {
    if (!pattern || /[\r\n]/.test(pattern)) {
      throw materializationError('Git exclude patterns must be single lines');
    }
  }

  const agentRoot = await agentWorktreeRoot(root);
  if (agentRoot) {
    await ensureAgentGitExcludes(agentRoot, uniquePatterns);
    return;
  }

  const gitDir = path.join(root, '.git');
  const gitEntry = await lstat(gitDir);
  if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
    throw materializationError('.git must be a real directory');
  }

  const infoDir = path.join(gitDir, 'info');
  await requireDirectory(infoDir, '.git/info');
  const excludePath = path.join(infoDir, 'exclude');
  try {
    const excludeEntry = await lstat(excludePath);
    if (excludeEntry.isSymbolicLink() || !excludeEntry.isFile()) {
      throw materializationError('.git/info/exclude must be a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let handle;
  try {
    handle = await open(
      excludePath,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw materializationError(
        '.git/info/exclude must not be a symbolic link',
      );
    }
    throw error;
  }

  try {
    if (!(await handle.stat()).isFile()) {
      throw materializationError('.git/info/exclude must be a regular file');
    }
    const existing = await handle.readFile('utf8');
    const existingPatterns = new Set(existing.split(/\r?\n/));
    const missing = uniquePatterns.filter(
      (pattern) => !existingPatterns.has(pattern),
    );
    if (missing.length === 0) return;

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await handle.write(`${prefix}${missing.join('\n')}\n`);
  } finally {
    await handle.close();
  }
}

export async function prepareWorktreeMaterialization(
  root: string,
  materializer?: WorktreeMaterializer,
): Promise<void> {
  if (!materializer?.gitExcludePatterns) return;
  try {
    await ensureLocalGitExcludes(root, materializer.gitExcludePatterns);
  } catch (error) {
    throw normalizeMaterializationError(error);
  }
}

export async function materializeWorktree(
  root: string,
  materializer?: WorktreeMaterializer,
): Promise<void> {
  if (!materializer) return;
  await prepareWorktreeMaterialization(root, materializer);
  try {
    await materializer.materialize(root);
  } catch (error) {
    throw normalizeMaterializationError(error);
  }
}
