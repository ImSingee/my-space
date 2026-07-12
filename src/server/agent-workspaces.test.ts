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
      reconcileRunnerWorkspaces({
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
});
