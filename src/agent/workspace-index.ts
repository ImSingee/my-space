/** Runner-private index of source worktrees used by one Agent chat. */
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { agentWorkspaceIndexPath, agentWorkDir, isSafeEntityId } from './paths';

export type WorkspaceKind = 'app' | 'workflow';

export type WorkspaceIndexEntry = {
  kind: WorkspaceKind;
  id: string;
  generation: string;
  absolutePath: string;
};

const chains = new Map<string, Promise<unknown>>();

export function isWorkspacePathInside(
  parent: string,
  candidate: string,
): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function workspacePathsOverlap(left: string, right: string): boolean {
  return (
    isWorkspacePathInside(left, right) || isWorkspacePathInside(right, left)
  );
}

function isValidIndexEntry(
  workspaceRoots: string[],
  entry: unknown,
): entry is WorkspaceIndexEntry {
  if (entry == null || typeof entry !== 'object') return false;
  const candidate = entry as WorkspaceIndexEntry;
  return (
    (candidate.kind === 'app' || candidate.kind === 'workflow') &&
    typeof candidate.id === 'string' &&
    isSafeEntityId(candidate.id) &&
    typeof candidate.generation === 'string' &&
    candidate.generation.length > 0 &&
    typeof candidate.absolutePath === 'string' &&
    path.isAbsolute(candidate.absolutePath) &&
    workspaceRoots.some((root) =>
      isWorkspacePathInside(root, candidate.absolutePath),
    )
  );
}

async function sessionWorkspaceRoots(sessionId: string): Promise<string[]> {
  const root = agentWorkDir(sessionId);
  try {
    return [...new Set([root, await realpath(root)])];
  } catch {
    return [root];
  }
}

async function readIndex(sessionId: string): Promise<WorkspaceIndexEntry[]> {
  try {
    const parsed = JSON.parse(
      await readFile(agentWorkspaceIndexPath(sessionId), 'utf8'),
    ) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    const roots = await sessionWorkspaceRoots(sessionId);
    return parsed.entries.filter((entry) => isValidIndexEntry(roots, entry));
  } catch {
    return [];
  }
}

async function writeIndex(
  sessionId: string,
  entries: WorkspaceIndexEntry[],
): Promise<void> {
  const target = agentWorkspaceIndexPath(sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ entries }, null, 2), 'utf8');
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const tail = chains.get(sessionId) ?? Promise.resolve();
  const result = tail.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(sessionId, settled);
  void settled.then(() => {
    if (chains.get(sessionId) === settled) chains.delete(sessionId);
  });
  return result;
}

export function listIndexedWorkspaces(
  sessionId: string,
): Promise<WorkspaceIndexEntry[]> {
  return serialize(sessionId, () => readIndex(sessionId));
}

export function registerWorkspace(
  sessionId: string,
  entry: WorkspaceIndexEntry,
  options: { replaceExactPath?: boolean } = {},
): Promise<void> {
  return serialize(sessionId, async () => {
    if (!isValidIndexEntry(await sessionWorkspaceRoots(sessionId), entry)) {
      throw new Error('Invalid workspace index entry.');
    }
    const entries = await readIndex(sessionId);
    const conflicting = entries.find((candidate) => {
      const samePath =
        path.resolve(candidate.absolutePath) ===
        path.resolve(entry.absolutePath);
      const sameEntry =
        candidate.kind === entry.kind && candidate.id === entry.id && samePath;
      return (
        !sameEntry &&
        !(options.replaceExactPath && samePath) &&
        workspacePathsOverlap(candidate.absolutePath, entry.absolutePath)
      );
    });
    if (conflicting) {
      throw new Error(
        `Workspace path ${entry.absolutePath} overlaps the registered ` +
          `${conflicting.kind} "${conflicting.id}" checkout at ` +
          `${conflicting.absolutePath}.`,
      );
    }
    const withoutDuplicate = entries.filter((candidate) =>
      options.replaceExactPath
        ? path.resolve(candidate.absolutePath) !==
          path.resolve(entry.absolutePath)
        : !(
            candidate.kind === entry.kind &&
            candidate.id === entry.id &&
            path.resolve(candidate.absolutePath) ===
              path.resolve(entry.absolutePath)
          ),
    );
    withoutDuplicate.push(entry);
    await writeIndex(sessionId, withoutDuplicate);
  });
}

export function removeIndexedWorkspaces(
  sessionId: string,
  predicate: (entry: WorkspaceIndexEntry) => boolean,
): Promise<WorkspaceIndexEntry[]> {
  return serialize(sessionId, async () => {
    const entries = await readIndex(sessionId);
    const removed = entries.filter(predicate);
    if (removed.length > 0) {
      await writeIndex(
        sessionId,
        entries.filter((entry) => !predicate(entry)),
      );
    }
    return removed;
  });
}
