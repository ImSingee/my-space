import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedRunnerInfo } from '~server/agent-runner/hub';
import type { ActiveRunSource } from '~server/agent-runner/status';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

// The hub tracks live WebSocket connections; the aggregation only consumes
// its snapshot list, so replace it with a controllable fake.
vi.mock('~server/agent-runner/hub', () => {
  type Hub = typeof import('~server/agent-runner/hub');
  return {
    listConnectedRunners: vi.fn<Hub['listConnectedRunners']>(() => []),
  };
});

const { db, schema } = await import('~/db');
const hub = await import('~server/agent-runner/hub');
const { buildAgentRunnerStatusSnapshot, getAgentRunnerStatusSnapshot } =
  await import('~server/agent-runner/status');

const NOW = new Date('2026-07-07T10:00:00.000Z');

function runner(overrides: Partial<ConnectedRunnerInfo> = {}) {
  return {
    runnerId: 'runner-a',
    protocolVersion: 1,
    activeRunCount: 0,
    connectedAt: '2026-07-07T09:00:00.000Z',
    lastSeenAt: '2026-07-07T09:59:55.000Z',
    ...overrides,
  };
}

function runSource(overrides: Partial<ActiveRunSource> = {}): ActiveRunSource {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    sessionTitle: 'Fix the deploy',
    status: 'running',
    runnerId: 'runner-a',
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    createdAt: new Date(NOW.getTime() - 30_000),
    ...overrides,
  };
}

describe('buildAgentRunnerStatusSnapshot', () => {
  it('is offline with no runners and no active runs', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [],
      activeRuns: [],
      now: NOW,
    });
    expect(snapshot.state).toBe('offline');
    expect(snapshot.generatedAt).toBe(NOW.toISOString());
    expect(snapshot.summary).toMatchObject({
      connectedRunners: 0,
      activeRuns: 0,
      blockedRuns: 0,
      staleLeases: 0,
    });
    expect(snapshot.summary.heartbeatIntervalMs).toBeGreaterThan(0);
    expect(snapshot.summary.leaseTtlMs).toBeGreaterThan(0);
  });

  it('is connected when a runner is connected', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [runner()],
      activeRuns: [runSource()],
      now: NOW,
    });
    expect(snapshot.state).toBe('connected');
    expect(snapshot.summary.connectedRunners).toBe(1);
    expect(snapshot.runners).toEqual([runner()]);
  });

  it('needs attention when an active run lease is expired, even with a runner online', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [runner()],
      activeRuns: [
        runSource({ leaseExpiresAt: new Date(NOW.getTime() - 1000) }),
      ],
      now: NOW,
    });
    expect(snapshot.state).toBe('attention');
    expect(snapshot.summary.staleLeases).toBe(1);
    expect(snapshot.activeRuns[0].lease).toBe('expired');
  });

  it('needs attention when an active run has no lease at all', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [],
      activeRuns: [runSource({ runnerId: null, leaseExpiresAt: null })],
      now: NOW,
    });
    expect(snapshot.state).toBe('attention');
    expect(snapshot.activeRuns[0].lease).toBe('missing');
  });

  it('counts running, blocked and stale runs', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [runner()],
      activeRuns: [
        runSource({ id: 'run-1' }),
        runSource({ id: 'run-2', status: 'blocked' }),
        runSource({
          id: 'run-3',
          leaseExpiresAt: new Date(NOW.getTime() - 5000),
        }),
      ],
      now: NOW,
    });
    expect(snapshot.summary.activeRuns).toBe(3);
    expect(snapshot.summary.blockedRuns).toBe(1);
    expect(snapshot.summary.staleLeases).toBe(1);
  });

  it('marks whether each run’s runner is connected and orders newest first', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [runner({ runnerId: 'runner-a' })],
      activeRuns: [
        runSource({ id: 'run-1', runnerId: 'runner-a' }),
        runSource({ id: 'run-2', runnerId: 'runner-gone' }),
        runSource({ id: 'run-3', runnerId: null }),
      ],
      now: NOW,
    });
    expect(snapshot.activeRuns.map((r) => r.runId)).toEqual([
      'run-3',
      'run-2',
      'run-1',
    ]);
    const byId = new Map(snapshot.activeRuns.map((r) => [r.runId, r]));
    expect(byId.get('run-1')?.runnerConnected).toBe(true);
    expect(byId.get('run-2')?.runnerConnected).toBe(false);
    expect(byId.get('run-3')?.runnerConnected).toBe(false);
  });

  it('falls back to a title for runs whose session title is missing', () => {
    const snapshot = buildAgentRunnerStatusSnapshot({
      runners: [],
      activeRuns: [runSource({ sessionTitle: null })],
      now: NOW,
    });
    expect(snapshot.activeRuns[0].sessionTitle).toBe('Untitled chat');
  });
});

describe('getAgentRunnerStatusSnapshot', () => {
  beforeEach(async () => {
    vi.mocked(hub.listConnectedRunners).mockReturnValue([]);
    await db.delete(schema.agentRuns);
    await db.delete(schema.agentSessions);
  });

  async function seedSession(id: string, title: string) {
    await db.insert(schema.agentSessions).values({ id, title });
  }

  async function seedRun(
    overrides: Partial<typeof schema.agentRuns.$inferInsert> & {
      id: string;
      sessionId: string;
    },
  ) {
    await db.insert(schema.agentRuns).values({
      providerId: 'provider-1',
      modelId: 'model-1',
      status: 'running',
      input: { userText: 'hi' },
      leaseExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });
  }

  it('joins active runs with their session titles and the hub runner list', async () => {
    vi.mocked(hub.listConnectedRunners).mockReturnValue([runner()]);
    await seedSession('session-1', 'Ship the feature');
    await seedRun({
      id: 'run-1',
      sessionId: 'session-1',
      runnerId: 'runner-a',
    });

    const snapshot = await getAgentRunnerStatusSnapshot();
    expect(snapshot.state).toBe('connected');
    expect(snapshot.summary).toMatchObject({
      connectedRunners: 1,
      activeRuns: 1,
      blockedRuns: 0,
      staleLeases: 0,
    });
    expect(snapshot.activeRuns).toHaveLength(1);
    expect(snapshot.activeRuns[0]).toMatchObject({
      runId: 'run-1',
      sessionId: 'session-1',
      sessionTitle: 'Ship the feature',
      runnerId: 'runner-a',
      runnerConnected: true,
      lease: 'live',
    });
  });

  it('ignores terminal runs and flags expired leases on active ones', async () => {
    await seedSession('session-1', 'Chat');
    await seedRun({
      id: 'run-done',
      sessionId: 'session-1',
      status: 'completed',
    });
    await seedRun({
      id: 'run-stuck',
      sessionId: 'session-1',
      status: 'blocked',
      runnerId: 'runner-a',
      leaseExpiresAt: new Date(Date.now() - 1000),
    });

    const snapshot = await getAgentRunnerStatusSnapshot();
    expect(snapshot.activeRuns.map((r) => r.runId)).toEqual(['run-stuck']);
    expect(snapshot.state).toBe('attention');
    expect(snapshot.summary.blockedRuns).toBe(1);
    expect(snapshot.summary.staleLeases).toBe(1);
    // The runner is offline (hub list is empty) but still recorded on the run.
    expect(snapshot.activeRuns[0].runnerConnected).toBe(false);
  });
});
