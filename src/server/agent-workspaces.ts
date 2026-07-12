/** Platform-side reconciliation snapshot for runner-local Agent workspaces. */
import { inArray } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { WorkspaceSourceClaim } from '~agent/protocol';

export async function reconcileRunnerWorkspaces(input: {
  sessionIds: string[];
  sources: WorkspaceSourceClaim[];
}): Promise<{
  staleSessionIds: string[];
  staleSources: WorkspaceSourceClaim[];
}> {
  const claimedSessions = [...new Set(input.sessionIds)];
  const sourceClaims = new Map<string, WorkspaceSourceClaim>();
  for (const source of input.sources) {
    sourceClaims.set(
      `${source.sessionId}:${source.kind}:${source.id}:${source.generation ?? 'unknown'}`,
      source,
    );
  }
  const appIds = [
    ...new Set(
      [...sourceClaims.values()]
        .filter((source) => source.kind === 'app')
        .map((source) => source.id),
    ),
  ];
  const workflowIds = [
    ...new Set(
      [...sourceClaims.values()]
        .filter((source) => source.kind === 'workflow')
        .map((source) => source.id),
    ),
  ];
  const [existingSessions, apps, workflows] = await Promise.all([
    claimedSessions.length > 0
      ? db
          .select({ id: schema.agentSessions.id })
          .from(schema.agentSessions)
          .where(inArray(schema.agentSessions.id, claimedSessions))
      : [],
    appIds.length > 0
      ? db
          .select({ id: schema.apps.id, createdAt: schema.apps.createdAt })
          .from(schema.apps)
          .where(inArray(schema.apps.id, appIds))
      : [],
    workflowIds.length > 0
      ? db
          .select({
            id: schema.workflows.id,
            createdAt: schema.workflows.createdAt,
          })
          .from(schema.workflows)
          .where(inArray(schema.workflows.id, workflowIds))
      : [],
  ]);
  const existingIds = new Set(existingSessions.map((row) => row.id));
  const existingApps = new Map(
    apps.map((row) => [row.id, row.createdAt.toISOString()]),
  );
  const existingWorkflows = new Map(
    workflows.map((row) => [row.id, row.createdAt.toISOString()]),
  );
  return {
    staleSessionIds: claimedSessions.filter((id) => !existingIds.has(id)),
    staleSources: [...sourceClaims.values()].filter(
      (source) =>
        existingIds.has(source.sessionId) &&
        (source.kind === 'app'
          ? existingApps.get(source.id) !== source.generation
          : existingWorkflows.get(source.id) !== source.generation),
    ),
  };
}
