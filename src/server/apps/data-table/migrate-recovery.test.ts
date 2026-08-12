import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postgres: vi.fn<() => unknown>(),
  databaseExists: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  appDataDatabaseExists: mocks.databaseExists,
  ensureAppDataDatabase: vi.fn<(id: string) => Promise<string>>(),
  resolveAppDataDatabaseUrl: () => 'postgres://data:data@127.0.0.1:5432/data',
}));

import {
  recoverCurrentDataSchema,
  waitForDataMigrationBarrier,
} from './migrate';

type TaggedSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

function recoveryHarness(run: (statement: string) => Promise<unknown[]>): {
  statements: string[];
  end: ReturnType<typeof vi.fn>;
} {
  const statements: string[] = [];
  const tx = (async (strings: TemplateStringsArray) => {
    const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim();
    statements.push(statement);
    return run(statement);
  }) as TaggedSql;
  const end = vi.fn<() => Promise<void>>(async () => {});
  mocks.postgres.mockReturnValue({
    begin: async (callback: (sql: TaggedSql) => Promise<unknown>) =>
      callback(tx),
    end,
  });
  return { statements, end };
}

describe('Data Table migration recovery barrier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.databaseExists.mockResolvedValue(true);
  });

  it('returns an authoritative empty state when the database does not exist', async () => {
    mocks.databaseExists.mockResolvedValue(false);

    await expect(recoverCurrentDataSchema('app-1')).resolves.toBeNull();
    await expect(waitForDataMigrationBarrier('app-1')).resolves.toBeUndefined();

    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it('waits for the migration lock before reading the committed schema', async () => {
    const schema = { version: 1, tables: {} } as const;
    const { statements, end } = recoveryHarness(async (statement) => {
      if (statement.includes('pg_advisory_xact_lock')) return [];
      if (statement.includes('to_regclass')) return [{ exists: true }];
      if (statement.includes('select schema_snapshot')) {
        return [{ schema_snapshot: schema, schema_hash: 'schema-hash' }];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });

    await expect(recoverCurrentDataSchema('app-1')).resolves.toEqual({
      schema,
      hash: 'schema-hash',
    });

    expect(statements[0]).toContain('pg_advisory_xact_lock');
    expect(statements[1]).toContain('to_regclass');
    expect(statements[2]).toContain('select schema_snapshot');
    expect(end).toHaveBeenCalledOnce();
  });

  it('propagates an unavailable barrier instead of guessing the outcome', async () => {
    const failure = new Error('migration outcome is still unavailable');
    const { end } = recoveryHarness(async (statement) => {
      if (statement.includes('pg_advisory_xact_lock')) throw failure;
      return [];
    });

    await expect(recoverCurrentDataSchema('app-1')).rejects.toBe(failure);
    expect(end).toHaveBeenCalledOnce();
  });
});
