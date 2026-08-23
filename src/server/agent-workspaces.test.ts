import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { reconcileRunnerWorkspaces } = await import('./agent-workspaces');

beforeEach(async () => {
  await db.delete(schema.agentRuns);
  await db.delete(schema.agentSessions);
  await db.delete(schema.apps);
  await db.delete(schema.workflows);
});

describe('runner workspace reconciliation', () => {
  it('returns deleted sessions as stale without inspecting their contents', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'active-session', title: 'Active' });

    await expect(
      reconcileRunnerWorkspaces('runner-a', [
        'active-session',
        'deleted-session',
      ]),
    ).resolves.toEqual({
      ownedSessionIds: ['active-session'],
      staleSessionIds: ['deleted-session'],
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
      reconcileRunnerWorkspaces('runner-a', [
        'owned-here',
        'unowned',
        'owned-elsewhere',
        'deleted-session',
      ]),
    ).resolves.toEqual({
      ownedSessionIds: ['owned-here', 'unowned'],
      staleSessionIds: ['deleted-session'],
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
      reconcileRunnerWorkspaces('runner-b', ['active-unowned']),
    ).resolves.toEqual({
      ownedSessionIds: [],
      staleSessionIds: [],
    });
    await expect(
      reconcileRunnerWorkspaces('runner-a', ['active-unowned']),
    ).resolves.toEqual({
      ownedSessionIds: ['active-unowned'],
      staleSessionIds: [],
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
      reconcileRunnerWorkspaces('runner-a', ['awaiting-dispatch']),
    ).resolves.toEqual({
      ownedSessionIds: [],
      staleSessionIds: [],
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
