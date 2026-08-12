import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postgres: vi.fn<() => unknown>(),
  ensureAppDataDatabase: vi.fn<() => Promise<string>>(),
}));

vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  ensureAppDataDatabase: mocks.ensureAppDataDatabase,
  resolveAppDataDatabaseUrl: () => 'postgres://data:data@127.0.0.1:5432/data',
}));

import { applyDataMigration, DataMigrationOutcomeUnknown } from './migrate';

type TaggedSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

function commitAckHarness(options: {
  verification: 'committed' | 'absent' | 'unavailable';
}) {
  const commitError = new Error('connection closed while awaiting COMMIT');
  let committedHash = '';
  const verificationStatements: string[] = [];
  const tx = Object.assign(
    (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim();
      if (statement.includes('select schema_snapshot')) return [];
      if (statement.includes('insert into _hatch.migrations')) {
        committedHash = String(values[1]);
        return [];
      }
      if (statement.includes('insert into _hatch.changes')) {
        return [{ seq: 1 }];
      }
      return [];
    }) as TaggedSql,
    {
      unsafe: vi.fn<
        (statement: string, params?: readonly unknown[]) => Promise<unknown[]>
      >(async () => []),
      json: (value: unknown) => value,
    },
  );
  const main = {
    begin: vi.fn<
      (callback: (sql: typeof tx) => Promise<unknown>) => Promise<unknown>
    >(async (callback) => {
      await callback(tx);
      throw commitError;
    }),
    end: vi.fn<() => Promise<void>>(async () => {}),
  };
  const verify = Object.assign(
    (async (strings: TemplateStringsArray) => {
      const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim();
      verificationStatements.push(statement);
      if (statement.includes('pg_advisory_unlock')) return [];
      if (options.verification === 'unavailable') {
        throw new Error('verification connection unavailable');
      }
      if (statement.includes('pg_advisory_lock')) return [];
      if (statement.includes('to_regclass')) {
        return [{ exists: options.verification === 'committed' }];
      }
      if (statement.includes('select schema_hash')) {
        return [{ schema_hash: committedHash }];
      }
      throw new Error(`Unexpected verification SQL: ${statement}`);
    }) as TaggedSql,
    { end: vi.fn<() => Promise<void>>(async () => {}) },
  );
  mocks.postgres.mockReturnValueOnce(main).mockReturnValueOnce(verify);
  return { commitError, verificationStatements };
}

describe('Data Table migration COMMIT reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAppDataDatabase.mockResolvedValue(
      'postgres://data:data@127.0.0.1:5432/data',
    );
  });

  it('returns success when the exact migration row confirms the commit', async () => {
    const { verificationStatements } = commitAckHarness({
      verification: 'committed',
    });

    await expect(
      applyDataMigration({
        id: 'app-1',
        deploymentId: 'deployment-1',
        schema: { version: 1, tables: {} },
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(verificationStatements[0]).toContain('pg_advisory_lock');
    expect(verificationStatements[1]).toContain('to_regclass');
  });

  it('marks the outcome unknown when reconciliation is unavailable', async () => {
    const { commitError } = commitAckHarness({ verification: 'unavailable' });

    const error = await applyDataMigration({
      id: 'app-1',
      deploymentId: 'deployment-1',
      schema: { version: 1, tables: {} },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DataMigrationOutcomeUnknown);
    expect(error).toMatchObject({ originalError: commitError });
  });

  it('preserves the original failure when absence is confirmed', async () => {
    const { commitError } = commitAckHarness({ verification: 'absent' });

    await expect(
      applyDataMigration({
        id: 'app-1',
        deploymentId: 'deployment-1',
        schema: { version: 1, tables: {} },
      }),
    ).rejects.toBe(commitError);
  });
});
