import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORED_PASSWORD = '0123456789abcdef'.repeat(4);

const state = vi.hoisted(() => ({
  appExists: true,
  storedCiphertext: null as string | null,
  dataDbName: null as string | null,
  roleExists: false,
  databaseExists: false,
  rolePassword: '',
  statements: [] as string[],
  failUnsafeContaining: null as string | null,
  passwordWrites: 0,
  lockCalls: 0,
  transactionTail: Promise.resolve(),
}));

vi.mock('~/db', async () => {
  const schema = await import('~/db/schema');

  const findApp = async () =>
    state.appExists
      ? { dataDbPasswordCiphertext: state.storedCiphertext }
      : undefined;

  const tx = {
    execute: vi.fn<() => Promise<void>>(async () => {
      state.lockCalls += 1;
    }),
    query: { apps: { findFirst: vi.fn<typeof findApp>(findApp) } },
    update: vi.fn<
      () => {
        set: (values: {
          dataDbName?: string | null;
          dataDbPasswordCiphertext?: string | null;
        }) => {
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
            state.dataDbName = values.dataDbName ?? null;
            state.storedCiphertext = values.dataDbPasswordCiphertext ?? null;
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
        const previousName = state.dataDbName;
        try {
          return await callback(tx);
        } catch (error) {
          state.storedCiphertext = previousCiphertext;
          state.dataDbName = previousName;
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
      if (statement.includes('pg_advisory_lock')) return [];
      if (statement.includes('pg_advisory_unlock')) return [];
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
const { appDbName } = await import('../provision');
const {
  appDataDatabaseUrl,
  appDataDbName,
  ensureAppDataDatabase,
  resolveAppDataDatabaseUrl,
} = await import('./provision');
const { decryptAppDataDbPassword, encryptAppDataDbPassword } =
  await import('../db-password');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    'APP_DATABASE_URL',
    'postgres://admin:admin@127.0.0.1:5432/platform?sslmode=require',
  );
  vi.stubEnv('APP_URL', 'http://localhost:3700');
  vi.stubEnv('SECRET', 'test-platform-secret');
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');

  state.appExists = true;
  state.storedCiphertext = null;
  state.dataDbName = null;
  state.roleExists = false;
  state.databaseExists = false;
  state.rolePassword = '';
  state.statements = [];
  state.failUnsafeContaining = null;
  state.passwordWrites = 0;
  state.lockCalls = 0;
  state.transactionTail = Promise.resolve();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('managed Data Table database naming', () => {
  it('uses a namespace disjoint from ordinary App databases', () => {
    expect(appDataDbName('foo')).not.toBe(appDbName('data-foo'));
    expect(appDataDbName('foo')).toMatch(/^hatch_data_[a-z0-9_]+$/);
    expect(appDataDbName('foo')).not.toMatch(/^app_/);
  });

  it('is deterministic, length bounded, and resistant to normalized ids', () => {
    const longId = `project-${'a'.repeat(200)}`;
    const name = appDataDbName(longId);

    expect(appDataDbName(longId)).toBe(name);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(appDataDbName(`${longId}-other`)).not.toBe(name);
    expect(appDataDbName('foo-bar')).not.toBe(appDataDbName('foo_bar'));
  });

  it('uses the supplied restricted credential and preserves URL options', () => {
    const url = new URL(appDataDatabaseUrl('foo', STORED_PASSWORD));

    expect(url.username).toBe(appDataDbName('foo'));
    expect(url.password).toBe(STORED_PASSWORD);
    expect(url.pathname).toBe(`/${appDataDbName('foo')}`);
    expect(url.searchParams.get('sslmode')).toBe('require');
  });
});

describe('managed Data Table database passwords', () => {
  it('creates the role and database with one encrypted random password', async () => {
    const url = new URL(await ensureAppDataDatabase('demo-app'));
    const password = url.password;
    const formerlyDerived = createHmac('sha256', 'test-platform-secret')
      .update(`app-data-db-password:${appDataDbName('demo-app')}`)
      .digest('hex');

    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(password).not.toBe(STORED_PASSWORD);
    expect(password).not.toBe(formerlyDerived);
    expect(state.rolePassword).toBe(password);
    expect(state.dataDbName).toBe(appDataDbName('demo-app'));
    expect(state.storedCiphertext).not.toBeNull();
    expect(state.storedCiphertext).not.toContain(password);
    expect(
      decryptAppDataDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(password);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(1);
    expect(state.statements).toContainEqual(
      expect.stringContaining(`create role "${appDataDbName('demo-app')}"`),
    );
    expect(state.statements).toContainEqual(
      expect.stringContaining(`create database "${appDataDbName('demo-app')}"`),
    );
  });

  it('decrypts and reuses a stored password', async () => {
    state.storedCiphertext = encryptAppDataDbPassword(
      'demo-app',
      STORED_PASSWORD,
    );
    state.roleExists = true;
    state.databaseExists = true;

    const result = await ensureAppDataDatabase('demo-app');

    expect(new URL(result).password).toBe(STORED_PASSWORD);
    expect(state.rolePassword).toBe(STORED_PASSWORD);
    expect(state.passwordWrites).toBe(0);
    expect(state.statements).toContainEqual(
      expect.stringContaining(`alter role "${appDataDbName('demo-app')}"`),
    );
  });

  it('resolves a stored password without touching Postgres administration', async () => {
    state.storedCiphertext = encryptAppDataDbPassword(
      'demo-app',
      STORED_PASSWORD,
    );

    const url = new URL(await resolveAppDataDatabaseUrl('demo-app'));

    expect(url.password).toBe(STORED_PASSWORD);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('serializes concurrent first-time provisioning onto one password', async () => {
    const [first, second] = await Promise.all([
      ensureAppDataDatabase('demo-app'),
      ensureAppDataDatabase('demo-app'),
    ]);

    expect(new URL(first).password).toBe(new URL(second).password);
    expect(state.passwordWrites).toBe(1);
    expect(state.lockCalls).toBe(2);
  });

  it('rejects malformed stored ciphertext instead of rotating it', async () => {
    state.storedCiphertext = '';

    await expect(ensureAppDataDatabase('demo-app')).rejects.toThrow(
      'Invalid Data Table database password ciphertext',
    );

    expect(state.passwordWrites).toBe(0);
    expect(postgres).not.toHaveBeenCalled();
  });

  it('rolls back a new ciphertext and converges on retry after DDL failure', async () => {
    state.failUnsafeContaining = 'create database';

    await expect(ensureAppDataDatabase('demo-app')).rejects.toThrow(
      'Injected SQL failure',
    );
    const interruptedPassword = state.rolePassword;
    expect(state.storedCiphertext).toBeNull();
    expect(state.roleExists).toBe(true);
    expect(state.databaseExists).toBe(false);

    const result = await ensureAppDataDatabase('demo-app');
    const password = new URL(result).password;

    expect(password).not.toBe(interruptedPassword);
    expect(state.rolePassword).toBe(password);
    expect(state.databaseExists).toBe(true);
    expect(
      decryptAppDataDbPassword('demo-app', state.storedCiphertext as string),
    ).toBe(password);
  });

  it('does not create resources for a missing App', async () => {
    state.appExists = false;

    await expect(ensureAppDataDatabase('missing')).rejects.toThrow(
      'App "missing" not found.',
    );

    expect(postgres).not.toHaveBeenCalled();
    expect(state.statements).toEqual([]);
  });

  it('does not invent a password when an unprovisioned URL is requested', async () => {
    await expect(resolveAppDataDatabaseUrl('demo-app')).rejects.toThrow(
      'Data Table database for App "demo-app" is not provisioned.',
    );

    expect(state.passwordWrites).toBe(0);
    expect(postgres).not.toHaveBeenCalled();
  });
});
