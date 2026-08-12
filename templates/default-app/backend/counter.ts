export type CounterRow = {
  id: string;
  value: number;
};

export type CounterStore = {
  find(): Promise<CounterRow | null>;
  insert(amount: number): Promise<CounterRow>;
  increment(id: string, amount: number): Promise<CounterRow | null>;
};

const MAX_UPDATE_ATTEMPTS = 5;

export async function readCounter(store: CounterStore): Promise<number> {
  return (await store.find())?.value ?? 0;
}

export async function incrementCounter(
  store: CounterStore,
  amount: number,
  isConflict: (error: unknown) => boolean,
): Promise<number> {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const current = await store.find();
    if (current) {
      const updated = await store.increment(current.id, amount);
      if (updated) return updated.value;
      continue;
    }

    try {
      return (await store.insert(amount)).value;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  throw new Error('Counter changed too frequently; retry.');
}
