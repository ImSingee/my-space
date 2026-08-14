import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INITIAL_ROLE_PASSWORD = 'f'.repeat(64);
const STORED_PASSWORD = '0123456789abcdef'.repeat(4);

const state = vi.hoisted(() => ({
  appExists: true,
  dbName: 'app_demo_app' as string | null,
  storedCiphertext: null as string | null,
  roleExists: true,
  databaseExists: true,
  rolePassword: 'f'.repeat(64),
  statements: [] as string[],
  failUnsafeContaining: null as string | null,
  passwordWrites: 0,
  lockCalls: 0,
  lifecycleLockCalls: 0,
  lifecycleUnlockCalls: 0,
  transactionTail: Promise.resolve(),
}));

vi.mock('~/db', async () => {
  const schema = await import('~/db/schema');

  const findApp = async () =>
    state.appExists
      ? {
          dbName: state.dbName,
          dbPasswordCiphertext: state.storedCiphertext,
        }
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
        try {
          return await callback(tx);
        } catch (error) {
          state.storedCiphertext = previousCiphertext;
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
      if (statement.includes('pg_advisory_lock')) {
        state.lifecycleLockCalls += 1;
        return [];
      }
      if (statement.includes('pg_advisory_unlock')) {
        state.lifecycleUnlockCalls += 1;
        return [];
      }
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
        if (statement.startsWith('drop database')) {
          state.databaseExists = false;
        }
        if (statement.startsWith('drop role')) {
          state.roleExists = false;
        }
      }),
      end: vi.fn<(_options?: { timeout: number }) => Promise<void>>(
        async () => {},
      ),
    });
  }

  return { default: vi.fn<typeof createClient>(createClient) };
});

const postgres = (await import('postgres')).default;
const {
  appDatabaseUrl,
  beginAppDatabaseDeployment,
  dropAppDatabase,
  ensureAppDatabase,
  resolveAppDatabaseUrl,
  withAppDatabaseLifecycle,
} = await import('./provision');
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
  state.dbName = 'app_demo_app';
  state.storedCiphertext = null;
  state.roleExists = true;
  state.databaseExists = true;
  state.rolePassword = INITIAL_ROLE_PASSWORD;
  state.statements = [];
  state.failUnsafeContaining = null;
  state.passwordWrites = 0;
  state.lockCalls = 0;
  state.lifecycleLockCalls = 0;
  state.lifecycleUnlockCalls = 0;
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
  it('initializes a NULL credential with one encrypted random password', async () => {
    const url = await ensureAppDatabase('demo-app');
    const password = new URL(url).password;

    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(password).not.toBe(INITIAL_ROLE_PASSWORD);
    expect(state.rolePassword).toBe(password);
    expect(state.storedCiphertext).not.toBeNull();
    expect(state.storedCiphertext).not.toContain(password);
    expect(
      decryptAppDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(password);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(1);
    expect(state.lifecycleLockCalls).toBe(1);
    expect(state.lifecycleUnlockCalls).toBe(1);
  });

  it('creates a new role and database with a random stored password', async () => {
    state.roleExists = false;
    state.databaseExists = false;
    state.rolePassword = '';

    const url = await ensureAppDatabase('demo-app');
    const password = new URL(url).password;

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

    const url = await ensureAppDatabase('demo-app');

    expect(new URL(url).password).toBe(STORED_PASSWORD);
    expect(state.rolePassword).toBe(STORED_PASSWORD);
    expect(state.storedCiphertext).toBe(originalCiphertext);
    expect(state.passwordWrites).toBe(0);
  });

  it('rejects a malformed stored ciphertext', async () => {
    state.storedCiphertext = '';

    await expect(ensureAppDatabase('demo-app')).rejects.toThrow(
      'Invalid app database password ciphertext',
    );

    expect(state.storedCiphertext).toBe('');
    expect(state.rolePassword).toBe(INITIAL_ROLE_PASSWORD);
    expect(state.passwordWrites).toBe(0);
  });

  it('serializes concurrent initialization onto one password', async () => {
    const [first, second] = await Promise.all([
      ensureAppDatabase('demo-app'),
      ensureAppDatabase('demo-app'),
    ]);

    expect(new URL(first).password).toBe(new URL(second).password);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(2);
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
    const url = await ensureAppDatabase('demo-app');

    expect(state.rolePassword).toBe(new URL(url).password);
    expect(state.storedCiphertext).not.toBeNull();
  });

  it('does not create orphaned database resources for a missing app', async () => {
    state.appExists = false;

    await expect(ensureAppDatabase('missing')).rejects.toThrow(
      'App "missing" not found.',
    );

    expect(postgres).toHaveBeenCalledOnce();
    expect(state.lifecycleLockCalls).toBe(1);
    expect(state.lifecycleUnlockCalls).toBe(1);
    expect(state.statements).toEqual([]);
  });
});

describe('resolveAppDatabaseUrl', () => {
  it('resolves an encrypted registered credential without provisioning DDL', async () => {
    state.storedCiphertext = encryptAppDbPassword('demo-app', STORED_PASSWORD);

    const url = await resolveAppDatabaseUrl('demo-app');

    expect(new URL(url).password).toBe(STORED_PASSWORD);
    expect(state.statements).toEqual([]);
    expect(state.passwordWrites).toBe(0);
    expect(state.lockCalls).toBe(0);
  });

  it('adapts a legacy registered database only when both resources exist', async () => {
    const url = await resolveAppDatabaseUrl('demo-app');

    expect(new URL(url).password).toMatch(/^[0-9a-f]{64}$/);
    expect(state.passwordWrites).toBe(1);
    expect(state.statements).not.toContainEqual(
      expect.stringContaining('create database'),
    );
    expect(state.statements).not.toContainEqual(
      expect.stringContaining('create role'),
    );
  });

  it('never recreates missing resources while resolving a retained database', async () => {
    state.roleExists = false;

    await expect(resolveAppDatabaseUrl('demo-app')).rejects.toThrow(
      'App database is not provisioned',
    );

    expect(state.statements).toEqual([]);
    expect(state.passwordWrites).toBe(0);
  });

  it('rejects an app whose database registration was cleared', async () => {
    state.dbName = null;

    await expect(resolveAppDatabaseUrl('demo-app')).rejects.toThrow(
      'App database is not provisioned',
    );

    expect(state.statements).toEqual([]);
  });
});

describe('database deployment lifecycle', () => {
  it('does not open or provision a database for a disabled deployment', async () => {
    await expect(
      beginAppDatabaseDeployment('demo-app', false),
    ).resolves.toMatchObject({ dbName: undefined });

    expect(postgres).not.toHaveBeenCalled();
    expect(state.passwordWrites).toBe(0);
  });

  it('holds the lifecycle lock until the deployment lease is released', async () => {
    const lease = await beginAppDatabaseDeployment('demo-app', true);
    let secondEntered = false;
    const waiting = withAppDatabaseLifecycle('demo-app', async () => {
      secondEntered = true;
    });

    await Promise.resolve();
    expect(lease.dbName).toBe('app_demo_app');
    expect(secondEntered).toBe(false);

    await lease.release();
    await waiting;
    expect(secondEntered).toBe(true);
    expect(state.lifecycleLockCalls).toBe(2);
    expect(state.lifecycleUnlockCalls).toBe(2);
  });

  it('releases the lifecycle lock after strict role cleanup fails', async () => {
    state.failUnsafeContaining = 'drop role';

    await expect(dropAppDatabase('demo-app')).rejects.toThrow(
      'Injected SQL failure',
    );

    expect(state.databaseExists).toBe(false);
    expect(state.roleExists).toBe(true);
    expect(state.lifecycleLockCalls).toBe(1);
    expect(state.lifecycleUnlockCalls).toBe(1);
  });
});
