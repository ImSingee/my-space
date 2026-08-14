/**
 * Server-only: execute agent-issued SQL against an app's own Postgres
 * database. Runs on the platform so the Agent Runner never receives database
 * connection strings; the runner calls this through the internal API.
 */
import { db } from '~/db';
import {
  APP_DATABASE_NOT_PROVISIONED_ERROR,
  withAppDatabaseLifecycle,
} from './provision';

/** Cap on rendered query output characters returned to the model. */
export const MAX_QUERY_CHARS = 60000;

export type AppDbQueryResult = {
  /** Rendered result (JSON rows or an OK summary), size-capped. */
  text: string;
  rowCount: number;
};

/**
 * Run one SQL statement against an already-registered app database. The
 * lifecycle lock prevents a retained database from being deleted while a query
 * is in flight. Only a successful database-capable deployment may provision or
 * recreate the database.
 */
export async function queryAppDatabase(
  id: string,
  statement: string,
  signal?: AbortSignal,
): Promise<AppDbQueryResult> {
  // Reject an unregistered database before opening the APP_DATABASE_URL lock
  // connection so the stable product error wins even on a partial install.
  const registered = await db.query.apps.findFirst({
    where: (row, { eq }) => eq(row.id, id),
    columns: { dbName: true },
  });
  if (!registered?.dbName) {
    throw new Error(APP_DATABASE_NOT_PROVISIONED_ERROR);
  }

  return withAppDatabaseLifecycle(id, async (database) => {
    // Resolve after taking the lock: manual deletion may have completed after
    // the optimistic precheck above.
    const url = await database.resolve();
    const postgres = (await import('postgres')).default;
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
  });
}
