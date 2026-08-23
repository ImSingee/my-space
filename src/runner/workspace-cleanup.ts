/** Runner-local Agent session discovery and whole-session cleanup. */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENTS_DIR,
  agentHomeDir,
  agentSessionDir,
  isSafePathSegment,
} from '~agent/paths';

async function childDirectoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listLocalWorkspaceSessionIds(): Promise<string[]> {
  return childDirectoryNames(AGENTS_DIR);
}

export async function removeSessionWorkspace(sessionId: string): Promise<void> {
  if (!isSafePathSegment(sessionId)) throw new Error('Invalid session id.');
  const target = agentSessionDir(sessionId);
  const relative = path.relative(AGENTS_DIR, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Session workspace escapes the Agent data root.');
  }
  await Promise.all([
    rm(target, { recursive: true, force: true }),
    rm(agentHomeDir(sessionId), { recursive: true, force: true }),
  ]);
}
