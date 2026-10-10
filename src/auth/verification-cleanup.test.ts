import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const fixture = vi.hoisted(() => ({
  close: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  const testDb = await createTestDb();
  fixture.close = () => testDb.db.$client.close();
  return testDb;
});

const { db, schema } = await import('~/db');
const { ensureVerificationCleanup, pruneExpiredVerifications } =
  await import('./verification-cleanup');

const NOW = new Date('2026-10-02T00:00:00.000Z');
let stop: (() => Promise<void>) | undefined;

function challenge(id: string, expiresAt: Date) {
  return {
    id,
    identifier: `token-${id}`,
    value: JSON.stringify({ type: 'authentication', expectedChallenge: id }),
    expiresAt,
  };
}

beforeEach(async () => {
  await db.delete(schema.verification);
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await fixture.close?.();
});

describe('verification retention', () => {
  it('drains abandoned challenges in batches without deleting valid challenges', async () => {
    await db
      .insert(schema.verification)
      .values([
        ...Array.from({ length: 2_501 }, (_, i) =>
          challenge(`expired-${i}`, new Date(NOW.getTime() - 1)),
        ),
        challenge('at-cutoff', NOW),
        challenge('valid', new Date(NOW.getTime() + 300_000)),
      ]);

    await expect(pruneExpiredVerifications()).resolves.toBe(2_501);
    const remaining = await db.select().from(schema.verification);
    expect(remaining.map((row) => row.id).sort()).toEqual([
      'at-cutoff',
      'valid',
    ]);
    await expect(pruneExpiredVerifications()).resolves.toBe(0);
  });

  it('cleans at startup and after expiry without another authentication request', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3700');
    vi.stubEnv(
      'SECRET',
      'verification-retention-test-secret-at-least-32-chars',
    );
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'verification-retention-test-runner');
    const { auth } = await import('./server');

    // These unauthenticated calls are the requests made by Conditional UI.
    // No credential response is ever sent to consume the resulting challenges.
    for (let i = 0; i < 3; i++) {
      const response = await auth.handler(
        new Request(
          'http://localhost:3700/api/auth/passkey/generate-authenticate-options',
        ),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        challenge: expect.any(String),
        rpId: 'localhost',
      });
    }
    await db
      .insert(schema.verification)
      .values(
        challenge('abandoned-before-restart', new Date(NOW.getTime() - 1)),
      );
    await expect(db.select().from(schema.verification)).resolves.toHaveLength(
      4,
    );

    stop = ensureVerificationCleanup();
    expect(ensureVerificationCleanup()).toBe(stop);
    await vi.waitFor(async () => {
      const remaining = await db.select().from(schema.verification);
      expect(remaining).toHaveLength(3);
      expect(
        remaining.every((row) => row.expiresAt.getTime() > NOW.getTime()),
      ).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(360_000);
    await vi.waitFor(async () => {
      await expect(db.select().from(schema.verification)).resolves.toEqual([]);
    });

    await stop();
    await db.insert(schema.verification).values(challenge('after-stop', NOW));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(db.select().from(schema.verification)).resolves.toHaveLength(
      1,
    );
  });

  it('retries a failed cleanup on the next interval', async () => {
    await db
      .insert(schema.verification)
      .values(challenge('abandoned', new Date(NOW.getTime() - 1)));
    const failure = new Error('Database temporarily unavailable');
    vi.spyOn(db, 'delete').mockImplementationOnce(() => {
      throw failure;
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    stop = ensureVerificationCleanup();
    await vi.waitFor(() => {
      expect(errorLog).toHaveBeenCalledWith(
        '[auth] verification cleanup failed:',
        failure,
      );
    });
    await expect(db.select().from(schema.verification)).resolves.toHaveLength(
      1,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      await expect(db.select().from(schema.verification)).resolves.toEqual([]);
    });
  });
});
