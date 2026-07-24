import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LEGACY_PASSWORD =
  'b17c3d570aa35bad7791d0f103b212d562693ceb1271dc94687573fb4ff213a2';
const STORED_PASSWORD = '0123456789abcdef'.repeat(4);

const state = vi.hoisted(() => ({
  appExists: true,
  storedCiphertext: null as string | null,
  roleExists: true,
  databaseExists: true,
  rolePassword:
    'b17c3d570aa35bad7791d0f103b212d562693ceb1271dc94687573fb4ff213a2',
  statements: [] as string[],
  failUnsafeContaining: null as string | null,
  failAfterCommit: false,
  passwordWrites: 0,
  lockCalls: 0,
  transactionTail: Promise.resolve(),
}));

vi.mock('~/db', async () => {
  const schema = await import('~/db/schema');

  const findApp = async () =>
    state.appExists
      ? { dbPasswordCiphertext: state.storedCiphertext }
      : undefined;

  const tx = {
    execute: vi.fn<() => Promise<void>>(async () => {
      state.lockCalls += 1;
    }),
    query: { apps: { findFirst: vi.fn<typeof findApp>(findApp) } },
    update: vi.fn<
      () => {
        set: (values: { dbPasswordCiphertext?: string | null }) => {
          where: () => {
            returning: () => Promise<{ id: string }[]>;
          };
        };
      }
    >(() => ({
      set: (values) => ({
        where: () => ({
          returning: async () => {
            if (!state.appExists) return [];
            state.storedCiphertext = values.dbPasswordCiphertext ?? null;
            state.passwordWrites += 1;
            return [{ id: 'demo-app' }];
          },
        }),
      }),
    })),
  };

  return {
    schema,
    db: {
      query: { apps: { findFirst: vi.fn<typeof findApp>(findApp) } },
      transaction: vi.fn<
        (callback: (value: typeof tx) => unknown) => Promise<unknown>
      >(async (callback) => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const previous = state.transactionTail;
        state.transactionTail = previous.then(() => gate);
        await previous;

        const previousCiphertext = state.storedCiphertext;
        let callbackCompleted = false;
        try {
          const result = await callback(tx);
          callbackCompleted = true;
          if (state.failAfterCommit) {
            state.failAfterCommit = false;
            throw new Error('Injected ambiguous commit failure');
          }
          return result;
        } catch (error) {
          if (!callbackCompleted) {
            state.storedCiphertext = previousCiphertext;
          }
          throw error;
        } finally {
          release();
        }
      }),
    },
  };
});

vi.mock('postgres', () => {
  function createClient() {
    const client = vi.fn<
      (parts: TemplateStringsArray) => Promise<{ exists: number }[]>
    >(async (parts) => {
      const statement = parts.join('?');
      if (statement.includes('from pg_roles')) {
        return state.roleExists ? [{ exists: 1 }] : [];
      }
      if (statement.includes('from pg_database')) {
        return state.databaseExists ? [{ exists: 1 }] : [];
      }
      throw new Error(`Unexpected SQL query: ${statement}`);
    });

    return Object.assign(client, {
      unsafe: vi.fn<(statement: string) => Promise<void>>(async (statement) => {
        state.statements.push(statement);
        if (
          state.failUnsafeContaining &&
          statement.includes(state.failUnsafeContaining)
        ) {
          state.failUnsafeContaining = null;
          throw new Error(`Injected SQL failure: ${statement}`);
        }

        const password = statement.match(
          /(?:create|alter) role "[^"]+" login password '([0-9a-f]{64})'/,
        )?.[1];
        if (password) {
          state.roleExists = true;
          state.rolePassword = password;
        }
        if (statement.startsWith('create database')) {
          state.databaseExists = true;
        }
      }),
      end: vi.fn<() => Promise<void>>(async () => {}),
    });
  }

  return { default: vi.fn<typeof createClient>(createClient) };
});

const postgres = (await import('postgres')).default;
const { appDatabaseUrl, ensureAppDatabase } = await import('./provision');
const { decryptAppDbPassword, encryptAppDbPassword } =
  await import('./db-password');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    'APP_DATABASE_URL',
    'postgres://admin:admin-password@db.example.test:5432/platform?sslmode=require',
  );
  vi.stubEnv('APP_URL', 'https://public.example.test');
  vi.stubEnv('SECRET', 'platform-secret');
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');

  state.appExists = true;
  state.storedCiphertext = null;
  state.roleExists = true;
  state.databaseExists = true;
  state.rolePassword = LEGACY_PASSWORD;
  state.statements = [];
  state.failUnsafeContaining = null;
  state.failAfterCommit = false;
  state.passwordWrites = 0;
  state.lockCalls = 0;
  state.transactionTail = Promise.resolve();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('appDatabaseUrl', () => {
  it('uses the restricted role and preserves admin URL connection options', () => {
    const url = new URL(appDatabaseUrl('demo-app', STORED_PASSWORD));

    expect(url.username).toBe('app_demo_app');
    expect(url.password).toBe(STORED_PASSWORD);
    expect(url.pathname).toBe('/app_demo_app');
    expect(url.searchParams.get('sslmode')).toBe('require');
  });
});

describe('ensureAppDatabase', () => {
  it('upgrades a legacy NULL credential to one encrypted random password', async () => {
    const result = await ensureAppDatabase('demo-app');
    const password = new URL(result.url).password;

    expect(result.passwordMigrated).toBe(true);
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(password).not.toBe(LEGACY_PASSWORD);
    expect(state.rolePassword).toBe(password);
    expect(state.storedCiphertext).not.toBeNull();
    expect(state.storedCiphertext).not.toContain(password);
    expect(
      decryptAppDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(password);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(1);
  });

  it('creates a new role and database with a random stored password', async () => {
    state.roleExists = false;
    state.databaseExists = false;
    state.rolePassword = '';

    const result = await ensureAppDatabase('demo-app');
    const password = new URL(result.url).password;

    expect(result.passwordMigrated).toBe(true);
    expect(password).not.toBe(LEGACY_PASSWORD);
    expect(state.rolePassword).toBe(password);
    expect(state.roleExists).toBe(true);
    expect(state.databaseExists).toBe(true);
    expect(state.statements).toContainEqual(
      expect.stringContaining('create role "app_demo_app"'),
    );
    expect(state.statements).toContainEqual(
      expect.stringContaining('create database "app_demo_app"'),
    );
  });

  it('decrypts and reuses an existing stored password', async () => {
    state.storedCiphertext = encryptAppDbPassword('demo-app', STORED_PASSWORD);
    const originalCiphertext = state.storedCiphertext;

    const result = await ensureAppDatabase('demo-app');

    expect(result.passwordMigrated).toBe(false);
    expect(new URL(result.url).password).toBe(STORED_PASSWORD);
    expect(state.rolePassword).toBe(STORED_PASSWORD);
    expect(state.storedCiphertext).toBe(originalCiphertext);
    expect(state.passwordWrites).toBe(0);
  });

  it('does not treat a malformed non-NULL ciphertext as legacy', async () => {
    state.storedCiphertext = '';

    await expect(ensureAppDatabase('demo-app')).rejects.toThrow(
      'Invalid app database password ciphertext',
    );

    expect(state.storedCiphertext).toBe('');
    expect(state.rolePassword).toBe(LEGACY_PASSWORD);
    expect(state.passwordWrites).toBe(0);
  });

  it('serializes concurrent initialization onto one password', async () => {
    const [first, second] = await Promise.all([
      ensureAppDatabase('demo-app'),
      ensureAppDatabase('demo-app'),
    ]);

    expect(new URL(first.url).password).toBe(new URL(second.url).password);
    expect([first.passwordMigrated, second.passwordMigrated].sort()).toEqual([
      false,
      true,
    ]);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(2);
  });

  it('returns a migrated result when COMMIT succeeded ambiguously', async () => {
    state.failAfterCommit = true;

    const result = await ensureAppDatabase('demo-app');
    const password = new URL(result.url).password;

    expect(result.passwordMigrated).toBe(true);
    expect(
      decryptAppDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(password);
    expect(state.rolePassword).toBe(password);
    expect(state.lockCalls).toBe(2);
  });

  it('does not let failed compensation overwrite a concurrent retry', async () => {
    state.failUnsafeContaining = 'grant all on schema public';

    const results = await Promise.allSettled([
      ensureAppDatabase('demo-app'),
      ensureAppDatabase('demo-app'),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(state.storedCiphertext).not.toBeNull();
    expect(
      decryptAppDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(state.rolePassword);
    expect(state.rolePassword).not.toBe(LEGACY_PASSWORD);
    expect(state.lockCalls).toBe(3);
  });

  it('restores the HMAC credential and NULL row after a failed upgrade', async () => {
    state.failUnsafeContaining = 'grant all on schema public';

    await expect(ensureAppDatabase('demo-app')).rejects.toThrow(
      'Injected SQL failure',
    );

    expect(state.storedCiphertext).toBeNull();
    expect(state.rolePassword).toBe(LEGACY_PASSWORD);
    expect(state.statements.at(-1)).toContain(
      `login password '${LEGACY_PASSWORD}'`,
    );
  });

  it('recovers on retry after an interrupted first-time provision', async () => {
    state.roleExists = false;
    state.databaseExists = false;
    state.failUnsafeContaining = 'grant all on schema public';

    await expect(ensureAppDatabase('demo-app')).rejects.toThrow(
      'Injected SQL failure',
    );
    expect(state.storedCiphertext).toBeNull();

    state.failUnsafeContaining = null;
    const result = await ensureAppDatabase('demo-app');

    expect(result.passwordMigrated).toBe(true);
    expect(state.rolePassword).toBe(new URL(result.url).password);
    expect(state.storedCiphertext).not.toBeNull();
  });

  it('does not create orphaned database resources for a missing app', async () => {
    state.appExists = false;

    await expect(ensureAppDatabase('missing')).rejects.toThrow(
      'App "missing" not found.',
    );

    expect(postgres).not.toHaveBeenCalled();
    expect(state.statements).toEqual([]);
  });
});
