import { beforeEach, describe, expect, it, vi } from 'vitest';

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
