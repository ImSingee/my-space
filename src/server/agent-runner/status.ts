/**
 * Server-only: aggregates the Agent Runner service's health for the
 * `/settings/agent-runner` page — connected runners from the hub's in-memory
 * state plus active `agent_runs` rows from the database. Pure aggregation
 * lives in {@link buildAgentRunnerStatusSnapshot} so it can be unit-tested
 * without a hub or a database.
 *
 * Deliberately excludes anything sensitive: no runner token, no internal
 * URLs, no environment details — only ids, counts and timestamps.
 */
import { inArray } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AgentRunStatus } from '~/db/schema';
import { RUN_LEASE_TTL_MS, RUNNER_HEARTBEAT_MS } from '~agent/protocol';
import { ACTIVE_STATUSES } from '~server/agent-runs';
import { listConnectedRunners, type ConnectedRunnerInfo } from './hub';

export type AgentRunnerState = 'connected' | 'offline' | 'attention';

/**
 * Lease health of one active run. `expired` and `missing` both mean the lease
 * contract is broken (the sweeper will interrupt the run) — the page surfaces
 * them as "stale" before that happens.
 */
export type AgentRunLeaseState = 'live' | 'expired' | 'missing';

export type ActiveAgentRunInfo = {
  runId: string;
  sessionId: string;
  sessionTitle: string;
  status: AgentRunStatus;
  /** Null while the run is still being dispatched to a runner. */
  runnerId: string | null;
  /** Whether the owning runner is currently connected to the hub. */
  runnerConnected: boolean;
  lease: AgentRunLeaseState;
  startedAt: string;
};

export type AgentRunnerStatusSnapshot = {
  generatedAt: string;
  state: AgentRunnerState;
  summary: {
    connectedRunners: number;
    activeRuns: number;
    blockedRuns: number;
    /** Active runs whose lease is expired or missing. */
    staleLeases: number;
    heartbeatIntervalMs: number;
    leaseTtlMs: number;
  };
  runners: ConnectedRunnerInfo[];
  activeRuns: ActiveAgentRunInfo[];
};

/** Trimmed active `agent_runs` row the aggregation needs. */
export type ActiveRunSource = {
  id: string;
  sessionId: string;
  sessionTitle: string | null;
  status: AgentRunStatus;
  runnerId: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
};

function classifyLease(
  leaseExpiresAt: Date | null,
  now: Date,
): AgentRunLeaseState {
  if (leaseExpiresAt == null) return 'missing';
  return leaseExpiresAt.getTime() > now.getTime() ? 'live' : 'expired';
}

/** Pure aggregation of hub + database state into the page snapshot. */
export function buildAgentRunnerStatusSnapshot(input: {
  runners: ConnectedRunnerInfo[];
  activeRuns: ActiveRunSource[];
  now: Date;
}): AgentRunnerStatusSnapshot {
  const { runners, now } = input;
  const connected = new Set(runners.map((runner) => runner.runnerId));

  const activeRuns: ActiveAgentRunInfo[] = input.activeRuns
    .map((run) => ({
      runId: run.id,
      sessionId: run.sessionId,
      sessionTitle: run.sessionTitle ?? 'Untitled chat',
      status: run.status,
      runnerId: run.runnerId,
      runnerConnected: run.runnerId != null && connected.has(run.runnerId),
      lease: classifyLease(run.leaseExpiresAt, now),
      startedAt: run.createdAt.toISOString(),
    }))
    // Newest first (ULIDs sort by creation time).
    .sort((a, b) => b.runId.localeCompare(a.runId));

  const staleLeases = activeRuns.filter((run) => run.lease !== 'live').length;
  const state: AgentRunnerState =
    staleLeases > 0
      ? 'attention'
      : runners.length > 0
        ? 'connected'
        : 'offline';

  return {
    generatedAt: now.toISOString(),
    state,
    summary: {
      connectedRunners: runners.length,
      activeRuns: activeRuns.length,
      blockedRuns: activeRuns.filter((run) => run.status === 'blocked').length,
      staleLeases,
      heartbeatIntervalMs: RUNNER_HEARTBEAT_MS,
      leaseTtlMs: RUN_LEASE_TTL_MS,
    },
    runners,
    activeRuns,
  };
}

/** Live snapshot for the status page: hub memory + active run rows. */
export async function getAgentRunnerStatusSnapshot(): Promise<AgentRunnerStatusSnapshot> {
  const runs = await db.query.agentRuns.findMany({
    where: (r, { inArray: within }) => within(r.status, ACTIVE_STATUSES),
  });

  const sessionIds = [...new Set(runs.map((run) => run.sessionId))];
  const sessions =
    sessionIds.length > 0
      ? await db
          .select({
            id: schema.agentSessions.id,
            title: schema.agentSessions.title,
          })
          .from(schema.agentSessions)
          .where(inArray(schema.agentSessions.id, sessionIds))
      : [];
  const titles = new Map(
    sessions.map((session) => [session.id, session.title]),
  );

  return buildAgentRunnerStatusSnapshot({
    runners: listConnectedRunners(),
    activeRuns: runs.map((run) => ({
      id: run.id,
      sessionId: run.sessionId,
      sessionTitle: titles.get(run.sessionId) ?? null,
      status: run.status,
      runnerId: run.runnerId,
      leaseExpiresAt: run.leaseExpiresAt,
      createdAt: run.createdAt,
    })),
    now: new Date(),
  });
}
