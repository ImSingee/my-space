/**
 * Server-only: execute agent-issued SQL against an app's own Postgres
 * database. Runs on the platform so the Agent Runner never receives database
 * connection strings; the runner calls this through the internal API.
 */
import { ensureAppDatabase } from './provision';

/** Cap on rendered query output characters returned to the model. */
export const MAX_QUERY_CHARS = 60000;

export type AppDbQueryResult = {
  /** Rendered result (JSON rows or an OK summary), size-capped. */
  text: string;
  rowCount: number;
};

/**
 * Provision the app database on first use, then run one SQL statement with
 * the same guardrails the in-process tool had: a 30s statement timeout, a
 * 100-row render cap, and a character cap so a few huge rows can't flood the
 * model context.
 */
export async function queryAppDatabase(
  id: string,
  statement: string,
  signal?: AbortSignal,
): Promise<AppDbQueryResult> {
  const postgres = (await import('postgres')).default;
  const url = await ensureAppDatabase(id);
  // Bound the statement so a runaway query (e.g. an accidental cross join or
  // `pg_sleep`) can't hang the tool — and thus the whole agent turn — for
  // minutes. Abort tears the connection down promptly on cancel.
  const sql = postgres(url, {
    max: 1,
    connection: { statement_timeout: 30000 },
  });
  const onAbort = () => {
    void sql.end({ timeout: 0 }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
  try {
    const rows = await sql.unsafe(statement);
    const full =
      rows.length > 0
        ? JSON.stringify(rows.slice(0, 100), null, 2)
        : `OK (${rows.count} row(s) affected).`;
    const text =
      full.length > MAX_QUERY_CHARS
        ? `${full.slice(0, MAX_QUERY_CHARS)}\n… (truncated)`
        : full;
    return { text, rowCount: rows.length };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await sql.end({ timeout: 5 });
  }
}
