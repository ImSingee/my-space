/** Resolve model-supplied paths without allowing escape from a chat workspace. */
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { agentWorkDir } from './paths';
import { writeAgentWorkspaceFile } from './sandboxed-file-io';

export type AgentWorkspacePath = {
  absolutePath: string;
  path: string;
  sessionId: string;
  /** Canonical root captured by the same resolution that produced this path. */
  rootAbsolutePath: string;
};

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
    sessionId,
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
  beforeCommit?: () => void | Promise<void>,
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

  return writeAgentWorkspaceFile(
    destination.sessionId,
    destination.absolutePath,
    content,
    signal,
    beforeCommit,
  );
}
