import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { reconcileRunnerWorkspaces } = await import('./agent-workspaces');
const APP_GENERATION = '2026-07-12T00:00:00.000Z';
const WORKFLOW_GENERATION = '2026-07-12T01:00:00.000Z';
const OLD_GENERATION = '2026-07-11T00:00:00.000Z';

beforeEach(async () => {
  await db.delete(schema.agentRuns);
  await db.delete(schema.agentSessions);
  await db.delete(schema.apps);
  await db.delete(schema.workflows);
});

describe('runner workspace reconciliation', () => {
  it('checks only the hello-time claims and ignores sources in stale sessions', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'active-session', title: 'Active' });
    await db.insert(schema.apps).values({
      id: 'current-app',
      slug: 'current-app',
      name: 'Current app',
      createdAt: new Date(APP_GENERATION),
    });
    await db.insert(schema.workflows).values({
      id: 'current-workflow',
      name: 'Current workflow',
      createdAt: new Date(WORKFLOW_GENERATION),
    });

    await expect(
      reconcileRunnerWorkspaces('runner-a', {
        sessionIds: ['active-session', 'deleted-session'],
        sources: [
          {
            sessionId: 'active-session',
            kind: 'app',
            id: 'current-app',
            generation: APP_GENERATION,
          },
          {
            sessionId: 'active-session',
            kind: 'app',
            id: 'current-app',
            generation: null,
          },
          {
            sessionId: 'active-session',
            kind: 'app',
            id: 'deleted-app',
            generation: OLD_GENERATION,
          },
          {
            sessionId: 'active-session',
            kind: 'workflow',
            id: 'current-workflow',
            generation: WORKFLOW_GENERATION,
          },
          {
            sessionId: 'active-session',
            kind: 'workflow',
            id: 'current-workflow',
            generation: OLD_GENERATION,
          },
          {
            sessionId: 'deleted-session',
            kind: 'workflow',
            id: 'deleted-workflow',
            generation: OLD_GENERATION,
          },
        ],
      }),
    ).resolves.toEqual({
      ownedSessionIds: ['active-session'],
      staleSessionIds: ['deleted-session'],
      staleSources: [
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'current-app',
          generation: null,
        },
        {
          sessionId: 'active-session',
          kind: 'app',
          id: 'deleted-app',
          generation: OLD_GENERATION,
        },
        {
          sessionId: 'active-session',
          kind: 'workflow',
          id: 'current-workflow',
          generation: OLD_GENERATION,
        },
      ],
    });
  });

  it('claims unowned workspaces and rejects duplicate runner claims', async () => {
    await db.insert(schema.agentSessions).values([
      {
        id: 'owned-here',
        title: 'Owned here',
        workspaceAffinityState: 'claimed',
        workspaceRunnerId: 'runner-a',
      },
      { id: 'unowned', title: 'Unowned' },
      {
        id: 'owned-elsewhere',
        title: 'Owned elsewhere',
        workspaceAffinityState: 'claimed',
        workspaceRunnerId: 'runner-b',
      },
      {
        id: 'missing-locally',
        title: 'Missing locally',
        workspaceAffinityState: 'claimed',
        workspaceRunnerId: 'runner-a',
      },
    ]);

    await expect(
      reconcileRunnerWorkspaces('runner-a', {
        sessionIds: [
          'owned-here',
          'unowned',
          'owned-elsewhere',
          'deleted-session',
        ],
        sources: [],
      }),
    ).resolves.toEqual({
      ownedSessionIds: ['owned-here', 'unowned'],
      staleSessionIds: ['deleted-session'],
      staleSources: [],
    });

    const sessions = await db.query.agentSessions.findMany();
    expect(
      Object.fromEntries(
        sessions.map((session) => [
          session.id,
          [session.workspaceAffinityState, session.workspaceRunnerId],
        ]),
      ),
    ).toEqual({
      'missing-locally': ['claimed', 'runner-a'],
      'owned-elsewhere': ['claimed', 'runner-b'],
      'owned-here': ['claimed', 'runner-a'],
      unowned: ['claimed', 'runner-a'],
    });
  });

  it('lets only a migrated active run owner claim its workspace', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'active-unowned', title: 'Active unowned' });
    await db.insert(schema.agentRuns).values({
      id: 'active-run',
      sessionId: 'active-unowned',
      providerId: 'provider',
      modelId: 'model',
      status: 'running',
      input: {},
      runnerId: 'runner-a',
    });

    await expect(
      reconcileRunnerWorkspaces('runner-b', {
        sessionIds: ['active-unowned'],
        sources: [],
      }),
    ).resolves.toEqual({
      ownedSessionIds: [],
      staleSessionIds: [],
      staleSources: [],
    });
    await expect(
      reconcileRunnerWorkspaces('runner-a', {
        sessionIds: ['active-unowned'],
        sources: [],
      }),
    ).resolves.toEqual({
      ownedSessionIds: ['active-unowned'],
      staleSessionIds: [],
      staleSources: [],
    });

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'active-unowned' },
    });
    expect(session?.workspaceAffinityState).toBe('claimed');
    expect(session?.workspaceRunnerId).toBe('runner-a');
  });

  it('does not claim across a newly created run awaiting dispatch', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'awaiting-dispatch', title: 'Awaiting dispatch' });
    await db.insert(schema.agentRuns).values({
      id: 'unassigned-run',
      sessionId: 'awaiting-dispatch',
      providerId: 'provider',
      modelId: 'model',
      status: 'running',
      input: {},
      runnerId: null,
    });

    await expect(
      reconcileRunnerWorkspaces('runner-a', {
        sessionIds: ['awaiting-dispatch'],
        sources: [],
      }),
    ).resolves.toEqual({
      ownedSessionIds: [],
      staleSessionIds: [],
      staleSources: [],
    });

    const session = await db.query.agentSessions.findFirst({
      where: { id: 'awaiting-dispatch' },
    });
    expect(session).toMatchObject({
      workspaceAffinityState: 'uninitialized',
      workspaceRunnerId: null,
    });
  });
});
