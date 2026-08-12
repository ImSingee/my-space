import { describe, expect, it, vi } from 'vitest';
import {
  incrementCounter,
  readCounter,
  type CounterRow,
  type CounterStore,
} from '../../../templates/default-app/backend/counter';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function conflict(): Error & { status: number } {
  return Object.assign(new Error('Already exists'), { status: 409 });
}

const isConflict = (error: unknown) =>
  error instanceof Error &&
  'status' in error &&
  (error as Error & { status: unknown }).status === 409;

describe('default counter template', () => {
  it('counts concurrent first increments without losing either write', async () => {
    let row: CounterRow | null = null;
    let initialFinds = 0;
    const bothFoundMissing = deferred();
    const store: CounterStore = {
      async find() {
        if (!row && initialFinds < 2) {
          initialFinds += 1;
          if (initialFinds === 2) bothFoundMissing.resolve();
          await bothFoundMissing.promise;
          return null;
        }
        return row ? { ...row } : null;
      },
      async insert(amount) {
        if (row) throw conflict();
        row = { id: 'counter-1', value: amount };
        return { ...row };
      },
      async increment(id, amount) {
        if (!row || row.id !== id) return null;
        row = { ...row, value: row.value + amount };
        return { ...row };
      },
    };

    const results = await Promise.all([
      incrementCounter(store, 1, isConflict),
      incrementCounter(store, 1, isConflict),
    ]);

    expect([...results].sort((left, right) => left - right)).toEqual([1, 2]);
    await expect(store.find()).resolves.toMatchObject({ value: 2 });
  });

  it('uses atomic store increments for an existing row', async () => {
    let row: CounterRow = { id: 'counter-1', value: 0 };
    const increment = vi.fn<CounterStore['increment']>(async (id, amount) => {
      if (row.id !== id) return null;
      row = { ...row, value: row.value + amount };
      return { ...row };
    });
    const store: CounterStore = {
      async find() {
        return { ...row };
      },
      async insert() {
        throw new Error('Unexpected insert');
      },
      increment,
    };

    const results = await Promise.all([
      incrementCounter(store, 1, isConflict),
      incrementCounter(store, 1, isConflict),
    ]);

    expect([...results].sort((left, right) => left - right)).toEqual([1, 2]);
    expect(row.value).toBe(2);
    expect(increment).toHaveBeenCalledTimes(2);
  });

  it('retries when a row is deleted between find and increment', async () => {
    let findCalls = 0;
    const store: CounterStore = {
      async find() {
        findCalls += 1;
        return findCalls === 1 ? { id: 'deleted-row', value: 4 } : null;
      },
      async insert(amount) {
        return { id: 'replacement-row', value: amount };
      },
      async increment() {
        return null;
      },
    };

    await expect(incrementCounter(store, 3, isConflict)).resolves.toBe(3);
    expect(findCalls).toBe(2);
  });

  it('propagates non-conflict insert failures', async () => {
    const failure = new Error('Database unavailable');
    const store: CounterStore = {
      async find() {
        return null;
      },
      async insert() {
        throw failure;
      },
      async increment() {
        return null;
      },
    };

    await expect(incrementCounter(store, 1, isConflict)).rejects.toBe(failure);
  });

  it('bounds retries during continuous deletion races', async () => {
    const increment = vi.fn<CounterStore['increment']>(async () => null);
    const store: CounterStore = {
      async find() {
        return { id: 'counter-1', value: 0 };
      },
      async insert() {
        throw new Error('Unexpected insert');
      },
      increment,
    };

    await expect(incrementCounter(store, 1, isConflict)).rejects.toThrow(
      'Counter changed too frequently; retry.',
    );
    expect(increment).toHaveBeenCalledTimes(5);
  });

  it('reads an empty counter as zero', async () => {
    const store: CounterStore = {
      async find() {
        return null;
      },
      async insert() {
        throw new Error('Unexpected insert');
      },
      async increment() {
        return null;
      },
    };

    await expect(readCounter(store)).resolves.toBe(0);
  });
});
