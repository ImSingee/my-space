/** Platform-side reconciliation snapshot for runner-local Agent workspaces. */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { WorkspaceSourceClaim } from '~agent/protocol';

export async function reconcileRunnerWorkspaces(
  runnerId: string,
  input: {
    sessionIds: string[];
    sources: WorkspaceSourceClaim[];
  },
): Promise<{
  ownedSessionIds: string[];
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
          .select({
            id: schema.agentSessions.id,
            workspaceAffinityState: schema.agentSessions.workspaceAffinityState,
            workspaceRunnerId: schema.agentSessions.workspaceRunnerId,
          })
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
  const validSessionIds = new Set<string>();
  const staleSessionIds = new Set(
    claimedSessions.filter(
      (id) => !existingSessions.some((session) => session.id === id),
    ),
  );
  for (const session of existingSessions) {
    if (
      session.workspaceAffinityState === 'claimed' &&
      session.workspaceRunnerId === runnerId
    ) {
      validSessionIds.add(session.id);
      continue;
    }
    if (session.workspaceAffinityState === 'claimed') {
      // Preserve duplicate pre-affinity workspaces. The Platform cannot know
      // whether this copy contains the only `.env` file, so an ownership
      // mismatch must keep it quarantined rather than delete it automatically.
      continue;
    }
    if (session.workspaceRunnerId != null) continue;
    const claim = await db.transaction(async (tx) => {
      // Serialize hello recovery against assignRunToRunner, which takes the
      // same session-row lock before recording its provisional run owner.
      // Without this barrier, a stale active-run snapshot could let another
      // runner claim the session between assignment and run.accepted.
      const [current] = await tx
        .select({
          workspaceAffinityState: schema.agentSessions.workspaceAffinityState,
          workspaceRunnerId: schema.agentSessions.workspaceRunnerId,
        })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, session.id))
        .for('update');
      if (!current) return 'missing' as const;
      if (current.workspaceAffinityState === 'claimed') {
        return current.workspaceRunnerId === runnerId
          ? ('owned' as const)
          : ('preserve' as const);
      }
      if (current.workspaceRunnerId != null) {
        throw new Error('Agent session workspace affinity is inconsistent.');
      }

      const [activeRun] = await tx
        .select({ runnerId: schema.agentRuns.runnerId })
        .from(schema.agentRuns)
        .where(
          and(
            eq(schema.agentRuns.sessionId, session.id),
            inArray(schema.agentRuns.status, ['running', 'blocked']),
          ),
        )
        .limit(1);
      if (activeRun && activeRun.runnerId !== runnerId) {
        // A null runner id is a newly created run whose dispatch has not chosen
        // a connection yet; it is a barrier too. A non-null different owner is
        // the only peer allowed to recover that live workspace.
        return 'preserve' as const;
      }

      await tx
        .update(schema.agentSessions)
        .set({
          workspaceAffinityState: 'claimed',
          workspaceRunnerId: runnerId,
        })
        .where(
          and(
            eq(schema.agentSessions.id, session.id),
            eq(schema.agentSessions.workspaceAffinityState, 'uninitialized'),
            isNull(schema.agentSessions.workspaceRunnerId),
          ),
        );
      return 'owned' as const;
    });
    if (claim === 'owned') {
      validSessionIds.add(session.id);
      continue;
    }
    if (claim === 'missing') staleSessionIds.add(session.id);
    // A different existing copy or a provisional run owns the claim race.
    // Never delete this one merely from an affinity mismatch: it may contain
    // the only legacy secret material.
  }
  // Absence from a hello snapshot never releases an existing affinity. A
  // missing/offline local volume must fail closed rather than silently move a
  // session whose `.env` and worktree exist only on the recorded runner.

  const existingApps = new Map(
    apps.map((row) => [row.id, row.createdAt.toISOString()]),
  );
  const existingWorkflows = new Map(
    workflows.map((row) => [row.id, row.createdAt.toISOString()]),
  );
  return {
    ownedSessionIds: [...validSessionIds],
    staleSessionIds: [...staleSessionIds],
    staleSources: [...sourceClaims.values()].filter(
      (source) =>
        validSessionIds.has(source.sessionId) &&
        (source.kind === 'app'
          ? existingApps.get(source.id) !== source.generation
          : existingWorkflows.get(source.id) !== source.generation),
    ),
  };
}
