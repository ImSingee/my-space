/** Durable Data Table change replay with LISTEN/NOTIFY as a wake-up hint. */
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { AppError } from '~server/errors';
import { resolveAppDataDatabaseUrl } from './provision';
import { parseDataRevision } from './revision';
import {
  acquireDataReadGuard,
  assertDataTableAccess,
  type DataTableAccessOptions,
} from './service';

export type DataChange = {
  seq: number;
  table: string;
  rowId: string | null;
  operation: string;
  createdAt: string;
};

type Subscriber = {
  cursor: number;
  table: string | null;
  access: DataTableAccessOptions;
  send: (change: DataChange | { reset: true; seq: number }) => void;
  close: (error: unknown) => void;
};

type Hub = {
  id: string;
  databaseUrl: string;
  sql: Sql;
  registryEntry: Promise<Hub> | undefined;
  subscribers: Set<Subscriber>;
  unlisten: () => Promise<void>;
  pump: Promise<void> | undefined;
  pumpRequested: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  validationTimer: ReturnType<typeof setInterval> | undefined;
  retryDelayMs: number;
  closed: boolean;
  closing: Promise<void> | undefined;
};

const PUMP_RETRY_INITIAL_MS = 1000;
const PUMP_RETRY_MAX_MS = 30_000;
const ACCESS_VALIDATION_INTERVAL_MS = 20_000;
const REPLAY_BATCH_SIZE = 1000;

type RealtimeGlobal = typeof globalThis & {
  __hatchDataRealtime?: Map<string, Promise<Hub>>;
};

function hubs(): Map<string, Promise<Hub>> {
  const g = globalThis as RealtimeGlobal;
  g.__hatchDataRealtime ??= new Map();
  return g.__hatchDataRealtime;
}

function toChange(row: {
  seq: string;
  table_name: string;
  row_id: string | null;
  operation: string;
  created_at: Date;
}): DataChange {
  return {
    seq: parseDataRevision(row.seq),
    table: row.table_name,
    rowId: row.row_id,
    operation: row.operation,
    createdAt: row.created_at.toISOString(),
  };
}

async function replayBatchInTransaction(
  tx: TransactionSql,
  subscriber: Subscriber,
): Promise<boolean> {
  const [range] = await tx<{ min: string; max: string }[]>`
    select coalesce(min(seq), 0)::text as min,
           coalesce(max(seq), 0)::text as max
    from _hatch.changes
  `;
  const min = parseDataRevision(range?.min ?? '0');
  const max = parseDataRevision(range?.max ?? '0');
  if (
    subscriber.cursor > max ||
    (subscriber.cursor > 0 && min > 0 && subscriber.cursor < min - 1)
  ) {
    subscriber.cursor = max;
    subscriber.send({ reset: true, seq: max });
    return false;
  }

  const rows = await tx<
    {
      seq: string;
      table_name: string;
      row_id: string | null;
      operation: string;
      created_at: Date;
    }[]
  >`
    select seq::text, table_name, row_id, operation, created_at
    from _hatch.changes
    where seq > ${subscriber.cursor}
    order by seq asc
    limit ${REPLAY_BATCH_SIZE}
  `;
  for (const row of rows) {
    const change = toChange(row);
    subscriber.cursor = change.seq;
    if (
      change.table === '*' ||
      !subscriber.table ||
      subscriber.table === change.table
    ) {
      subscriber.send(change);
    }
  }
  return rows.length === REPLAY_BATCH_SIZE;
}

async function replayBatchFor(
  hub: Hub,
  subscriber: Subscriber,
): Promise<boolean> {
  // Check platform state before touching the Data DB. In particular, deletion
  // force-closes that database; without this preflight a broken LISTEN client
  // could retry forever without ever reaching the authoritative 404 guard.
  await assertDataTableAccess(hub.id, subscriber.access);
  return hub.sql.begin('isolation level repeatable read', async (tx) => {
    // Lock first, then inspect the durable platform fence/current deployment.
    // This closes the race between the route's initial check and a deployment
    // that starts while the SSE response is being established.
    await acquireDataReadGuard(tx, hub.id, subscriber.access);
    return replayBatchInTransaction(tx, subscriber);
  });
}

function clearPumpRetry(hub: Hub): void {
  if (hub.retryTimer === undefined) return;
  clearTimeout(hub.retryTimer);
  hub.retryTimer = undefined;
}

function closeHub(hub: Hub): Promise<void> {
  if (hub.closing) return hub.closing;
  hub.closed = true;
  clearPumpRetry(hub);
  if (hub.validationTimer) clearInterval(hub.validationTimer);
  hub.validationTimer = undefined;
  const map = hubs();
  if (!hub.registryEntry || map.get(hub.id) === hub.registryEntry) {
    map.delete(hub.id);
  }
  hub.closing = Promise.resolve()
    .then(() => hub.unlisten())
    .catch(() => {})
    .then(() => hub.sql.end({ timeout: 5 }).catch(() => {}));
  return hub.closing;
}

function removeSubscriber(hub: Hub, subscriber: Subscriber): void {
  hub.subscribers.delete(subscriber);
  if (hub.subscribers.size === 0) void closeHub(hub);
}

function closeHubSubscribers(hub: Hub, error: AppError): void {
  const subscribers = [...hub.subscribers];
  hub.subscribers.clear();
  for (const subscriber of subscribers) subscriber.close(error);
}

function isTerminalAccessError(error: unknown): boolean {
  return error instanceof AppError && [404, 409, 503].includes(error.status);
}

function schedulePumpRetry(hub: Hub): void {
  if (hub.closed || hub.subscribers.size === 0 || hub.retryTimer) return;
  const delay = hub.retryDelayMs;
  hub.retryDelayMs = Math.min(delay * 2, PUMP_RETRY_MAX_MS);
  hub.retryTimer = setTimeout(() => {
    hub.retryTimer = undefined;
    pumpHub(hub);
  }, delay);
  hub.retryTimer.unref?.();
}

function pumpHub(hub: Hub): void {
  if (hub.closed || hub.subscribers.size === 0) return;
  // A notification or a freshly restored LISTEN connection is a better wake-up
  // signal than an outstanding retry timer, so replay immediately.
  clearPumpRetry(hub);
  hub.pumpRequested = true;
  if (hub.pump) return;

  let failed = false;
  const pending = (async () => {
    while (hub.pumpRequested && !hub.closed && hub.subscribers.size > 0) {
      hub.pumpRequested = false;
      const more = await Promise.all(
        [...hub.subscribers].map(async (subscriber) => {
          try {
            return await replayBatchFor(hub, subscriber);
          } catch (error) {
            if (!isTerminalAccessError(error)) throw error;
            // End only this stream. A clean EOF makes the client reconnect,
            // where the route returns the explicit stale/missing/finalizing
            // status instead of silently heartbeating through a durable fence.
            removeSubscriber(hub, subscriber);
            subscriber.close(error);
            return false;
          }
        }),
      );
      // A stale subscriber may have many retained changes. Continue in another
      // short transaction so the migration guard is released every batch.
      if (more.some(Boolean)) hub.pumpRequested = true;
      if (!hub.closed) {
        hub.retryDelayMs = PUMP_RETRY_INITIAL_MS;
        clearPumpRetry(hub);
      }
    }
  })()
    .catch((error) => {
      failed = true;
      console.error('[data-table] realtime replay failed:', error);
      schedulePumpRetry(hub);
    })
    .finally(() => {
      if (hub.pump === pending) hub.pump = undefined;
      // A wake-up that arrived after the loop's final condition needs a fresh
      // pump. After a failure, the backoff timer owns the next attempt.
      if (!failed && hub.pumpRequested) pumpHub(hub);
    });
  hub.pump = pending;
}

async function createHub(id: string, databaseUrl: string): Promise<Hub> {
  const sql = postgres(databaseUrl, { max: 2 });
  const hub: Hub = {
    id,
    databaseUrl,
    sql,
    registryEntry: undefined,
    subscribers: new Set(),
    unlisten: async () => {},
    pump: undefined,
    pumpRequested: false,
    retryTimer: undefined,
    validationTimer: undefined,
    retryDelayMs: PUMP_RETRY_INITIAL_MS,
    closed: false,
    closing: undefined,
  };
  try {
    const listener = await sql.listen(
      'hatch_data_changes',
      () => pumpHub(hub),
      // postgres-js invokes onlisten after the initial LISTEN and after every
      // reconnect. NOTIFY is only a hint, so always reconcile the durable log
      // after a gap in the listener connection.
      () => pumpHub(hub),
    );
    hub.unlisten = () => listener.unlisten();
    return hub;
  } catch (error) {
    // A failed initial LISTEN never reaches closeHub(), so release the client
    // here instead of leaving its reconnect machinery alive without a registry
    // entry that deletion can close.
    hub.closed = true;
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

async function getHub(id: string): Promise<Hub> {
  const map = hubs();
  for (;;) {
    const databaseUrl = await resolveAppDataDatabaseUrl(id);
    let pending = map.get(id);
    if (!pending) {
      pending = createHub(id, databaseUrl).catch((error) => {
        if (map.get(id) === pending) map.delete(id);
        throw error;
      });
      map.set(id, pending);
    }
    const hub = await pending;
    hub.registryEntry ??= pending;
    if (hub.databaseUrl === databaseUrl) return hub;

    // Another platform process may have deleted and recreated this App while
    // this process retained its old LISTEN client. Credential identity is part
    // of the cache contract: close stale streams and rebuild instead of retrying
    // authentication forever on the superseded client.
    closeHubSubscribers(
      hub,
      new AppError('Data Table connection is stale.', 409),
    );
    await closeHub(hub);
  }
}

/**
 * Close this process's listener and every open stream for one App. Deletion
 * awaits this before dropping the database so postgres-js cannot reconnect a
 * LISTEN session to a database whose ownership is being removed.
 */
export async function closeDataRealtime(id: string): Promise<void> {
  const pending = hubs().get(id);
  if (!pending) return;
  let hub: Hub;
  try {
    hub = await pending;
  } catch {
    return;
  }
  hub.registryEntry ??= pending;
  const closing = closeHub(hub);
  const error = new AppError('Data Table is not available.', 404);
  closeHubSubscribers(hub, error);
  await closing;
}

export async function subscribeDataChanges(options: {
  id: string;
  since: number;
  table?: string | null;
  expectedDeploymentId?: string;
  send: Subscriber['send'];
  close?: Subscriber['close'];
}): Promise<() => void> {
  const access = { expectedDeploymentId: options.expectedDeploymentId };
  for (;;) {
    // Avoid opening a new LISTEN client for an App already known to be stale or
    // unavailable. The second check below closes the race with deletion while
    // this first platform read is in flight.
    await assertDataTableAccess(options.id, access);
    const hub = await getHub(options.id);
    if (hub.closed) continue;

    try {
      // Once the hub is registered, deletion can see and close its pending/live
      // client. Revalidate before attaching so a stale preflight can never add a
      // subscriber after closeDataRealtime has already taken its snapshot.
      await assertDataTableAccess(options.id, access);
    } catch (error) {
      if (hub.subscribers.size === 0) await closeHub(hub);
      throw error;
    }
    if (hub.closed) continue;

    const subscriber: Subscriber = {
      cursor: Math.max(0, options.since),
      table: options.table ?? null,
      access,
      send: options.send,
      close: options.close ?? (() => {}),
    };
    // No await is allowed between the closed check and this add. That makes the
    // attachment atomic with respect to closeDataRealtime's subscriber snapshot
    // in this process.
    hub.subscribers.add(subscriber);
    if (!hub.validationTimer) {
      // LISTEN reconnect callbacks cover transport gaps, while this periodic
      // replay covers deployment/fence changes that produce no table mutation.
      hub.validationTimer = setInterval(
        () => pumpHub(hub),
        ACCESS_VALIDATION_INTERVAL_MS,
      );
      hub.validationTimer.unref?.();
    }
    pumpHub(hub);

    return () => {
      removeSubscriber(hub, subscriber);
    };
  }
}
