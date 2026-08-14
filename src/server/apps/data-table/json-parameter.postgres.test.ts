import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATA_TABLE_TEST_DATABASE_URL;

describe('Data Table JSON PostgreSQL parameter encoding', () => {
  it.skipIf(!databaseUrl)(
    'round-trips every JSON root type without double encoding',
    async () => {
      if (!databaseUrl) return;

      const sql = postgres(databaseUrl, { max: 1 });
      const cases = [
        { value: { nested: ['daily', 1, true, null] }, kind: 'object' },
        { value: [{ time: '08:00' }, { time: '20:00' }], kind: 'array' },
        { value: 'plain text', kind: 'string' },
        { value: 42.5, kind: 'number' },
        { value: false, kind: 'boolean' },
        { value: null, kind: 'null' },
      ] as const;

      try {
        for (const testCase of cases) {
          const [row] = await sql.unsafe<{ value: unknown; kind: string }[]>(
            'select $1::text::jsonb as value, jsonb_typeof($1::text::jsonb) as kind',
            [JSON.stringify(testCase.value)],
          );

          expect(row?.kind).toBe(testCase.kind);
          expect(row?.value).toEqual(testCase.value);
        }
      } finally {
        await sql.end();
      }
    },
  );
});
