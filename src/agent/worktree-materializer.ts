import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

export type WorktreeMaterializer = {
  gitExcludePatterns?: readonly string[];
  materialize(root: string): Promise<void>;
};

function materializationError(reason: string): Error {
  return new Error(`Cannot prepare generated worktree files: ${reason}.`);
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
  await ensureLocalGitExcludes(root, materializer.gitExcludePatterns);
}

export async function materializeWorktree(
  root: string,
  materializer?: WorktreeMaterializer,
): Promise<void> {
  if (!materializer) return;
  await prepareWorktreeMaterialization(root, materializer);
  await materializer.materialize(root);
}
