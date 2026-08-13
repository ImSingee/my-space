/** Agent-facing orchestration for managed Data Table operations. */
import type {
  ParsedQueryAppDataTableRequest,
  QueryAppDataTableResponse,
} from '~agent/protocol';
import { AppError } from '~server/errors';
import {
  assertDataTableAccess,
  DATA_AGENT_RESULT_MAX_CHARS,
  executeDataTableRawSql,
  inspectDataTables,
  mutateDataTable,
  queryDataTable,
} from './data-table/service';

export async function queryAppDataTable(
  id: string,
  input: ParsedQueryAppDataTableRequest,
  signal?: AbortSignal,
): Promise<QueryAppDataTableResponse> {
  // Fail with the capability/deployment fence before trying to open a Data DB
  // that may not exist yet. Each service operation repeats this check while
  // holding the migration guard so a concurrent cutover cannot race it.
  await assertDataTableAccess(id, {});

  switch (input.action) {
    case 'inspect': {
      const inspected = await inspectDataTables(id);
      if (!inspected) return { action: 'inspect', data: null };

      const { schema, schemaHash, tables } = inspected;
      if (!input.table) {
        const full = { schema, schemaHash, tables };
        if (
          JSON.stringify(full, null, 2).length <= DATA_AGENT_RESULT_MAX_CHARS
        ) {
          return { action: 'inspect', data: full };
        }
        return {
          action: 'inspect',
          data: {
            schema: { ...schema, tables: {} },
            schemaHash,
            tables: [],
            truncated: true,
          },
        };
      }

      const table = Object.hasOwn(schema.tables, input.table)
        ? schema.tables[input.table]
        : undefined;
      if (!table) {
        throw new AppError(`Unknown Data Table "${input.table}".`, 400);
      }
      const data = {
        schema: {
          ...schema,
          tables: { [input.table]: table },
        },
        schemaHash,
        tables: tables.filter((candidate) => candidate.name === input.table),
      };
      if (JSON.stringify(data, null, 2).length > DATA_AGENT_RESULT_MAX_CHARS) {
        throw new AppError(
          `Data Table schema for "${input.table}" exceeds the Agent output ` +
            'budget. Inspect data/schema.ts in the App source instead.',
          413,
        );
      }
      return {
        action: 'inspect',
        data,
      };
    }

    case 'query': {
      const { action: _action, ...query } = input;
      const result = await queryDataTable(id, query, {
        resultMaxChars: DATA_AGENT_RESULT_MAX_CHARS,
      });
      return {
        action: 'query',
        items: result.items,
        cursor: result.cursor,
        revision: result.revision,
        truncated: result.truncated ?? false,
      };
    }

    case 'mutate': {
      const { action: _action, ...mutation } = input;
      return {
        action: 'mutate',
        ...(await mutateDataTable(id, mutation, {
          resultMaxChars: DATA_AGENT_RESULT_MAX_CHARS,
        })),
      };
    }

    case 'raw_sql':
      return {
        action: 'raw_sql',
        ...(await executeDataTableRawSql(
          id,
          input.sql,
          input.timeoutMs,
          signal,
        )),
      };
  }
}
