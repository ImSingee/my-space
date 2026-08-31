import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { associateAgentSessionApp } = await import('./agent-session-apps');

beforeEach(async () => {
  await db.delete(schema.agentSessions);
  await db.delete(schema.apps);
});

describe('Agent conversation App associations', () => {
  it('associates a legacy kebab-case App id and inserts idempotently', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'session-one', title: 'Session one' });
    await db.insert(schema.apps).values({
      id: 'canonical-app',
      slug: 'mutable-slug',
      name: 'Mutable App',
    });

    await expect(
      associateAgentSessionApp('session-one', 'canonical-app'),
    ).resolves.toEqual({ appId: 'canonical-app' });
    await associateAgentSessionApp('session-one', 'canonical-app');

    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual([
      { sessionId: 'session-one', appId: 'canonical-app' },
    ]);
  });

  it('returns 404 when the supplied value matches only an App slug', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'session-one', title: 'Session one' });
    await db.insert(schema.apps).values({
      id: 'canonical-app',
      slug: 'mutable-slug',
      name: 'Mutable App',
    });

    await expect(
      associateAgentSessionApp('session-one', 'mutable-slug'),
    ).rejects.toThrow('App "mutable-slug" not found.');
    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual(
      [],
    );
  });

  it('does not create an association until both targets resolve', async () => {
    await db
      .insert(schema.agentSessions)
      .values({ id: 'session-one', title: 'Session one' });
    await db.insert(schema.apps).values({
      id: 'canonical-app',
      slug: 'mutable-slug',
      name: 'Mutable App',
    });

    await expect(
      associateAgentSessionApp('session-one', 'missing-app'),
    ).rejects.toThrow('App "missing-app" not found.');
    await expect(
      associateAgentSessionApp('missing-session', 'canonical-app'),
    ).rejects.toThrow('Agent session not found.');
    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual(
      [],
    );
  });

  it('cascades associations when either conversation or App is deleted', async () => {
    await db.insert(schema.agentSessions).values([
      { id: 'session-one', title: 'Session one' },
      { id: 'session-two', title: 'Session two' },
    ]);
    await db.insert(schema.apps).values([
      { id: 'app-one', slug: 'app-one', name: 'App one' },
      { id: 'app-two', slug: 'app-two', name: 'App two' },
    ]);
    await db.insert(schema.agentSessionApps).values([
      { sessionId: 'session-one', appId: 'app-one' },
      { sessionId: 'session-one', appId: 'app-two' },
      { sessionId: 'session-two', appId: 'app-two' },
    ]);

    await db.delete(schema.apps).where(eq(schema.apps.id, 'app-one'));
    await db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.id, 'session-two'));

    await expect(db.select().from(schema.agentSessionApps)).resolves.toEqual([
      { sessionId: 'session-one', appId: 'app-two' },
    ]);
  });
});
