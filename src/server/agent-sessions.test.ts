import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '~/db/schema';

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder = {
      middleware: () => builder,
      validator: (next: (value: never) => unknown) => {
        validate = (value) => next(value as never);
        return builder;
      },
      handler:
        (handler: (context: { data: never }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) as never }),
    };
    return builder;
  },
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('./auth', () => ({ authMiddleware: {} }));

const { db, schema } = await import('~/db');
const { getSession, listSessions } = await import('./agent-sessions');

beforeEach(async () => {
  await db.delete(schema.agentSessions);
  await db.delete(schema.apps);

  await db.insert(schema.apps).values([
    { id: 'app-a', slug: 'app-a', name: 'App A' },
    { id: 'app-b', slug: 'app-b', name: 'App B' },
  ]);
  await db.insert(schema.agentSessions).values([
    {
      id: 'session-old',
      title: 'Older session',
      messages: [{ role: 'user', content: 'one' }],
      updatedAt: new Date('2026-08-23T10:00:00.000Z'),
    },
    {
      id: 'session-new',
      title: 'Newer session',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
      updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    },
    {
      id: 'session-unrelated',
      title: 'No Apps',
      updatedAt: new Date('2026-08-22T10:00:00.000Z'),
    },
  ]);
  await db.insert(schema.agentSessionApps).values([
    { sessionId: 'session-old', appId: 'app-a' },
    { sessionId: 'session-new', appId: 'app-b' },
    { sessionId: 'session-new', appId: 'app-a' },
  ]);
});

/** A run row; times are minutes after 09:00 on 2026-08-24. */
function run(
  sessionId: string,
  id: string,
  userTurn: number | null,
  status: 'running' | 'failed' | 'interrupted' | 'completed',
  startedMinute: number,
  completedMinute: number | null,
  error: string | null = null,
) {
  const at = (minute: number) =>
    new Date(Date.parse('2026-08-24T09:00:00.000Z') + minute * 60_000);
  return {
    id,
    sessionId,
    providerId: 'provider-a',
    modelId: 'model-a',
    status,
    input: (userTurn === null
      ? { userText: 'legacy' }
      : { userTurn }) as JsonObject,
    createdAt: at(startedMinute),
    completedAt: completedMinute === null ? null : at(completedMinute),
    error,
  };
}

describe('Agent session App projections', () => {
  it('returns every cumulative App id on session summaries and details', async () => {
    const sessions = await listSessions({ data: {} });

    expect(
      sessions.map(({ id, appIds, messageCount }) => ({
        id,
        appIds,
        messageCount,
      })),
    ).toEqual([
      { id: 'session-new', appIds: ['app-a', 'app-b'], messageCount: 2 },
      { id: 'session-old', appIds: ['app-a'], messageCount: 1 },
      { id: 'session-unrelated', appIds: [], messageCount: 0 },
    ]);
    await expect(getSession({ data: 'session-new' })).resolves.toMatchObject({
      id: 'session-new',
      appIds: ['app-a', 'app-b'],
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    });
  });

  it('times the newest run of each user turn in the same snapshot', async () => {
    await db
      .insert(schema.agentRuns)
      .values([
        run('session-new', 'run-legacy', null, 'completed', 9, 9.5),
        run('session-new', 'run-failed', 0, 'failed', 10, 10.1, 'Old error'),
        run(
          'session-new',
          'run-retried',
          0,
          'interrupted',
          20,
          21,
          'Runner went away',
        ),
        run('session-new', 'run-active', 1, 'running', 30, null),
      ]);

    const session = await getSession({ data: 'session-new' });

    expect(session?.activeRun).toMatchObject({
      id: 'run-active',
      startedAt: '2026-08-24T09:30:00.000Z',
      userTurn: 1,
    });
    // A Retry supersedes the failed run of the same turn; a run without a
    // recorded turn is never paired with a reply by guesswork. The error is
    // what history shows when the transcript holds no reply for the turn.
    expect(session?.runs).toEqual([
      {
        id: 'run-retried',
        status: 'interrupted',
        userTurn: 0,
        startedAt: '2026-08-24T09:20:00.000Z',
        completedAt: '2026-08-24T09:21:00.000Z',
        error: 'Runner went away',
      },
      {
        id: 'run-active',
        status: 'running',
        userTurn: 1,
        startedAt: '2026-08-24T09:30:00.000Z',
        completedAt: null,
        error: null,
      },
    ]);
    expect(Number.isNaN(Date.parse(session?.serverTime ?? ''))).toBe(false);
  });

  it('binds an active run from before recorded turns to its snapshot', async () => {
    await db
      .insert(schema.agentRuns)
      .values([run('session-old', 'run-legacy', null, 'running', 30, null)]);

    const session = await getSession({ data: 'session-old' });

    // It answers the snapshot's last user message; its timing stays unknown.
    expect(session?.activeRun).toMatchObject({
      id: 'run-legacy',
      userTurn: 0,
    });
    expect(session?.runs).toEqual([]);
  });

  it('filters by one App while preserving all App ids on each match', async () => {
    await expect(
      listSessions({ data: { appId: 'app-b' } }),
    ).resolves.toMatchObject([
      { id: 'session-new', appIds: ['app-a', 'app-b'] },
    ]);
    await expect(
      listSessions({ data: { appId: 'missing-app' } }),
    ).resolves.toEqual([]);
  });
});
