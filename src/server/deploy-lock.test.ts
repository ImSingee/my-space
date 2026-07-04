import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { TX } from '~/db/db';
import { createDeployLock } from './deploy-lock';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createDeployLock().withLock', () => {
  it('serializes calls for the same id in submission order', async () => {
    const lock = createDeployLock(99);
    const order: string[] = [];
    const gate = deferred();

    const first = lock.withLock('app', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 1;
    });
    const second = lock.withLock('app', async () => {
      order.push('second:start');
      return 2;
    });

    await tick();
    // Second must not start while first is in flight.
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs different ids concurrently', async () => {
    const lock = createDeployLock(99);
    const order: string[] = [];
    const gate = deferred();

    const a = lock.withLock('a', async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
    });
    const b = lock.withLock('b', async () => {
      order.push('b:start');
    });

    await tick();
    expect(order).toEqual(['a:start', 'b:start']);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it('a failed call surfaces its error and does not wedge later calls', async () => {
    const lock = createDeployLock(99);

    const failing = lock.withLock('app', async () => {
      throw new Error('deploy failed');
    });
    const following = lock.withLock('app', async () => 'ok');

    await expect(failing).rejects.toThrow('deploy failed');
    await expect(following).resolves.toBe('ok');
  });

  it('runs a queued call even if it was enqueued after a failure', async () => {
    const lock = createDeployLock(99);
    await expect(
      lock.withLock('app', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    // The internal chain has settled; a fresh call still runs.
    await expect(lock.withLock('app', async () => 42)).resolves.toBe(42);
  });
});

describe('createDeployLock().acquire', () => {
  it('takes the advisory lock in the provided transaction with its namespace', async () => {
    const lock = createDeployLock(7);
    const queries: { sql: string; params: unknown[] }[] = [];
    const fakeTx = {
      execute: (query: SQL) => {
        // Render through the public dialect API instead of poking at the SQL
        // object's internals.
        queries.push(new PgDialect().sqlToQuery(query));
        return Promise.resolve([]);
      },
    } as unknown as TX;

    await lock.acquire(fakeTx, 'my-app');
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
    );
    // Namespace and id are bound as params in that order — a swap here would
    // let app and workflow deploys lock each other's namespace.
    expect(queries[0].params).toEqual([7, 'my-app']);
  });
});
