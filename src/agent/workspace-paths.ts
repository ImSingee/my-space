/** Resolve model-supplied paths without allowing escape from a chat workspace. */
import { spawn } from 'node:child_process';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { agentWorkDir } from './paths';

export type AgentWorkspacePath = {
  absolutePath: string;
  path: string;
  /** Canonical root captured by the same resolution that produced this path. */
  rootAbsolutePath: string;
};

const SECURE_WRITE_HELPER = String.raw`
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const expectedRoot = process.argv[1];
const parts = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8'),
);
if (!Array.isArray(parts) || parts.length === 0 ||
    parts.some((part) => typeof part !== 'string' || !part ||
      part === '.' || part === '..' || part.includes('/') ||
      part.includes('\\') || part.includes('\0'))) {
  throw new Error('Invalid workspace destination.');
}

const actualRoot = await realpath('.');
if (actualRoot !== expectedRoot) {
  throw new Error('Agent workdir changed during attachment write.');
}

const destination = parts.at(-1);
const temporary = '.hatch-download-' + crypto.randomUUID() + '.tmp';
const staged = path.join(expectedRoot, temporary);
let complete = false;
try {
  const handle = await open(
    staged,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o666,
  );
  try {
    for await (const chunk of process.stdin) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
        );
        if (bytesWritten <= 0) {
          throw new Error('Could not write the complete attachment body.');
        }
        offset += bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }

  for (const part of parts.slice(0, -1)) {
    try {
      await mkdir(part);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    process.chdir(part);
    const current = await realpath('.');
    if (!isInside(expectedRoot, current)) {
      throw new Error('Attachment destination escaped the Agent workdir.');
    }
  }

  await rename(staged, destination);
  complete = true;
} finally {
  if (!complete) await rm(staged, { force: true });
}
`;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute or workspace-relative path. Existing symlinks in every
 * prefix are canonicalized before the final containment check, so a path that
 * looks local but traverses a symlink outside the workspace is rejected.
 */
export async function resolveAgentWorkspacePath(
  sessionId: string,
  input: string,
): Promise<AgentWorkspacePath> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Workspace path is required.');
  }

  const root = agentWorkDir(sessionId);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const lexicalTarget = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);
  // Reject a plain `..`/host-path escape before canonicalizing existing
  // prefixes. On macOS either `/var/...` or its `/private/var/...` real path may
  // be supplied, so accept lexical containment against either root spelling.
  if (
    !isInside(path.resolve(root), lexicalTarget) &&
    !isInside(canonicalRoot, lexicalTarget)
  ) {
    throw new Error(`Path must be inside the Agent workdir: ${input}`);
  }
  let existing = lexicalTarget;
  while (!(await exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalExisting = await realpath(existing);
  if (!isInside(canonicalRoot, canonicalExisting)) {
    throw new Error(
      `Path escapes the Agent workdir through a symlink: ${input}`,
    );
  }

  const canonicalTarget = path.resolve(
    canonicalExisting,
    path.relative(existing, lexicalTarget),
  );
  if (
    !isInside(canonicalRoot, canonicalTarget) ||
    canonicalTarget === canonicalRoot
  ) {
    throw new Error(`Path must be inside the Agent workdir: ${input}`);
  }

  return {
    absolutePath: canonicalTarget,
    path: path
      .relative(canonicalRoot, canonicalTarget)
      .split(path.sep)
      .join('/'),
    rootAbsolutePath: canonicalRoot,
  };
}

/**
 * Write through a fixed directory cwd rather than reopening an already
 * validated absolute path. Each directory hop is canonicalized before the
 * next mutation, and the final replacement is an in-directory atomic rename.
 */
export function writeResolvedAgentWorkspaceFile(
  destination: AgentWorkspacePath,
  content: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const parts = destination.path.split('/');
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('/') ||
        part.includes('\\') ||
        part.includes('\0'),
    ) ||
    path.resolve(destination.rootAbsolutePath, ...parts) !==
      destination.absolutePath
  ) {
    return Promise.reject(new Error('Invalid workspace destination.'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        '--allow-fs-read=*',
        `--allow-fs-write=${destination.rootAbsolutePath}`,
        '--input-type=module',
        '--eval',
        SECURE_WRITE_HELPER,
        destination.rootAbsolutePath,
        Buffer.from(JSON.stringify(parts)).toString('base64url'),
      ],
      {
        cwd: destination.rootAbsolutePath,
        env: {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
        },
        signal,
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finish(error);
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          stderr.trim() ||
            `Secure attachment writer exited with status ${code ?? 'unknown'}.`,
        ),
      );
    });
    child.stdin.end(content);
  });
}
