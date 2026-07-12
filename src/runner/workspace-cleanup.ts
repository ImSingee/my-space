/** Runner-local workspace deletion and reconnect reconciliation. */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  removeSourceWorkspaces,
  removeSourceWorkspacesUnderBarrier,
  type SourceKind,
  type SourceWorkspaceBarrier,
} from '~agent/local-sources';
import {
  AGENTS_DIR,
  agentSessionDir,
  agentWorkDir,
  isSafeEntityId,
  isSafePathSegment,
} from '~agent/paths';
import type { WorkspaceSourceClaim } from '~agent/protocol';
import { listIndexedWorkspaces } from '~agent/workspace-index';

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
  await rm(target, { recursive: true, force: true });
}

async function defaultWorkspaceIds(
  sessionId: string,
  kind: SourceKind,
): Promise<string[]> {
  const namespace = kind === 'app' ? 'apps' : 'workflows';
  return childDirectoryNames(path.resolve(agentWorkDir(sessionId), namespace));
}

export async function inspectLocalWorkspaces(): Promise<{
  sessionIds: string[];
  sources: WorkspaceSourceClaim[];
}> {
  const sessionIds = await listLocalWorkspaceSessionIds();
  const claims = new Map<string, WorkspaceSourceClaim>();
  for (const sessionId of sessionIds) {
    const [indexed, defaultApps, defaultWorkflows] = await Promise.all([
      listIndexedWorkspaces(sessionId),
      defaultWorkspaceIds(sessionId, 'app'),
      defaultWorkspaceIds(sessionId, 'workflow'),
    ]);
    for (const entry of indexed) {
      const claim = {
        sessionId,
        kind: entry.kind,
        id: entry.id,
        generation: entry.generation,
      } as const;
      claims.set(
        `${sessionId}:${entry.kind}:${entry.id}:${entry.generation}`,
        claim,
      );
    }
    for (const id of defaultApps) {
      if (!isSafeEntityId(id)) continue;
      const absolutePath = path.resolve(agentWorkDir(sessionId), 'apps', id);
      if (
        indexed.some(
          (entry) =>
            entry.kind === 'app' &&
            entry.id === id &&
            path.resolve(entry.absolutePath) === absolutePath,
        )
      ) {
        continue;
      }
      claims.set(`${sessionId}:app:${id}:unknown`, {
        sessionId,
        kind: 'app',
        id,
        generation: null,
      });
    }
    for (const id of defaultWorkflows) {
      if (!isSafeEntityId(id)) continue;
      const absolutePath = path.resolve(
        agentWorkDir(sessionId),
        'workflows',
        id,
      );
      if (
        indexed.some(
          (entry) =>
            entry.kind === 'workflow' &&
            entry.id === id &&
            path.resolve(entry.absolutePath) === absolutePath,
        )
      ) {
        continue;
      }
      claims.set(`${sessionId}:workflow:${id}:unknown`, {
        sessionId,
        kind: 'workflow',
        id,
        generation: null,
      });
    }
  }
  return { sessionIds, sources: [...claims.values()] };
}

export async function reconcileLocalWorkspaces(
  input: {
    staleSessionIds: string[];
    staleSources: WorkspaceSourceClaim[];
  },
  barrier?: SourceWorkspaceBarrier,
): Promise<void> {
  const stale = new Set(input.staleSessionIds);
  await Promise.all([...stale].map(removeSessionWorkspace));

  const claims = new Map<string, WorkspaceSourceClaim>();
  for (const source of input.staleSources) {
    if (stale.has(source.sessionId)) continue;
    claims.set(
      `${source.sessionId}:${source.kind}:${source.id}:${source.generation ?? 'unknown'}`,
      source,
    );
  }
  for (const source of claims.values()) {
    if (barrier) {
      await removeSourceWorkspacesUnderBarrier(
        barrier,
        source.sessionId,
        source.kind,
        source.id,
        source.generation,
      );
    } else {
      await removeSourceWorkspaces(
        source.sessionId,
        source.kind,
        source.id,
        source.generation,
      );
    }
  }
}

export async function removeEntityWorkspaces(
  kind: SourceKind,
  id: string,
  generation: string,
): Promise<void> {
  if (!isSafePathSegment(id)) throw new Error(`Invalid ${kind} id.`);
  const sessions = await listLocalWorkspaceSessionIds();
  await Promise.all(
    sessions.map((sessionId) =>
      removeSourceWorkspaces(sessionId, kind, id, generation),
    ),
  );
}
