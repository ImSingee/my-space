// @ts-self-types="./data.d.ts"
/** @hatch/data — schema DSL and runtime client for managed Data Tables. */

declare const __DATA_DEPLOYMENT_ID__: string;

export const DATA_DEPLOYMENT_HEADER = 'x-hatch-data-deployment';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DataFieldKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'enum'
  | 'reference';

export type DataFieldDescriptor = {
  kind: DataFieldKind;
  optional: boolean;
  default?: JsonValue | { $hatch: 'now' };
  enumValues?: string[];
  referenceTable?: string;
  renamedFrom?: string;
};

type FieldFlags = { optional: boolean; hasDefault: boolean };

type FieldDefaultValue<
  TValue,
  TKind extends DataFieldKind,
> = 'reference' extends TKind
  ? never
  : [TKind] extends ['json']
    ? TValue extends JsonValue
      ? TValue
      : JsonValue
    : [TKind] extends ['enum']
      ? Extract<NonNullable<TValue>, string>
      : [TKind] extends ['string' | 'datetime']
        ? string
        : [TKind] extends ['integer' | 'number']
          ? number
          : [TKind] extends ['boolean']
            ? boolean
            : never;

export class DataField<
  TValue,
  TFlags extends FieldFlags = { optional: false; hasDefault: false },
  TKind extends DataFieldKind = DataFieldKind,
> {
  declare readonly _value: TValue;
  declare readonly _flags: TFlags;
  declare readonly _kind: TKind;

  constructor(readonly descriptor: DataFieldDescriptor) {}

  optional(): DataField<
    TValue | null,
    { optional: true; hasDefault: TFlags['hasDefault'] },
    TKind
  > {
    return new DataField({ ...this.descriptor, optional: true });
  }

  default(
    this: 'reference' extends TKind ? never : DataField<TValue, TFlags, TKind>,
    value: FieldDefaultValue<TValue, TKind>,
  ): DataField<
    TValue,
    { optional: TFlags['optional']; hasDefault: true },
    TKind
  > {
    return new DataField({
      ...this.descriptor,
      default: value as JsonValue,
    });
  }

  defaultNow(
    this: DataField<TValue, TFlags, 'datetime'>,
  ): DataField<
    TValue,
    { optional: TFlags['optional']; hasDefault: true },
    'datetime'
  > {
    return new DataField({
      ...this.descriptor,
      default: { $hatch: 'now' },
    });
  }

  renamedFrom(name: string): DataField<TValue, TFlags, TKind> {
    return new DataField({ ...this.descriptor, renamedFrom: name });
  }
}

function field<T, TKind extends DataFieldKind>(
  kind: TKind,
): DataField<T, { optional: false; hasDefault: false }, TKind> {
  return new DataField({ kind, optional: false });
}

export const t = {
  string: () => field<string, 'string'>('string'),
  integer: () => field<number, 'integer'>('integer'),
  number: () => field<number, 'number'>('number'),
  boolean: () => field<boolean, 'boolean'>('boolean'),
  datetime: () => field<string, 'datetime'>('datetime'),
  json: <T extends JsonValue = JsonValue>() => field<T, 'json'>('json'),
  enum: <const TValues extends readonly [string, ...string[]]>(
    values: TValues,
  ) =>
    new DataField<
      TValues[number],
      { optional: false; hasDefault: false },
      'enum'
    >({
      kind: 'enum',
      optional: false,
      enumValues: [...values],
    }),
  ref: <TTable extends string>(table: TTable) =>
    new DataField<string, { optional: false; hasDefault: false }, 'reference'>({
      kind: 'reference',
      optional: false,
      referenceTable: table,
    }),
};

type AnyDataField = {
  [TKind in DataFieldKind]: DataField<unknown, FieldFlags, TKind>;
}[DataFieldKind];

export type DataFields = Record<string, AnyDataField>;

export type DataIndexDescriptor = {
  name: string;
  fields: string[];
  unique: boolean;
};

export type DataTableDescriptor = {
  fields: Record<string, DataFieldDescriptor>;
  indexes: DataIndexDescriptor[];
  renamedFrom?: string;
};

export class DataTable<TFields extends DataFields> {
  constructor(
    readonly fields: TFields,
    readonly descriptor: DataTableDescriptor,
  ) {}

  index(
    name: string,
    fields: readonly (
      | (keyof TFields & string)
      | 'id'
      | 'createdAt'
      | 'updatedAt'
    )[],
  ): this {
    this.descriptor.indexes.push({ name, fields: [...fields], unique: false });
    return this;
  }

  uniqueIndex(
    name: string,
    fields: readonly (
      | (keyof TFields & string)
      | 'id'
      | 'createdAt'
      | 'updatedAt'
    )[],
  ): this {
    this.descriptor.indexes.push({ name, fields: [...fields], unique: true });
    return this;
  }

  renamedFrom(name: string): this {
    this.descriptor.renamedFrom = name;
    return this;
  }
}

export function defineTable<TFields extends DataFields>(
  fields: TFields,
): DataTable<TFields> {
  return new DataTable(fields, {
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, value.descriptor]),
    ),
    indexes: [],
  });
}

export type DataSchemaTables = Record<string, DataTable<DataFields>>;

export type DataSchema<TTables extends DataSchemaTables = DataSchemaTables> = {
  readonly tables: TTables;
  readonly descriptor: {
    version: 1;
    tables: Record<string, DataTableDescriptor>;
  };
};

export function defineSchema<TTables extends DataSchemaTables>(
  tables: TTables,
): DataSchema<TTables> {
  return {
    tables,
    descriptor: {
      version: 1,
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, table]) => [name, table.descriptor]),
      ),
    },
  };
}

type FieldValue<TField> =
  TField extends DataField<
    infer TValue,
    FieldFlags,
    infer _TKind extends DataFieldKind
  >
    ? TValue
    : never;

type FieldOptional<TField> =
  TField extends DataField<
    unknown,
    infer TFlags,
    infer _TKind extends DataFieldKind
  >
    ? TFlags['optional'] extends true
      ? true
      : TFlags['hasDefault'] extends true
        ? true
        : false
    : false;

type OptionalKeys<TFields extends DataFields> = {
  [K in keyof TFields]: FieldOptional<TFields[K]> extends true ? K : never;
}[keyof TFields];

type UnsettableKeys<TFields extends DataFields> = {
  [K in keyof TFields]: TFields[K]['_flags']['optional'] extends false
    ? never
    : K;
}[keyof TFields];

type IncrementableKeys<TFields extends DataFields> = {
  [K in keyof TFields]: TFields[K]['_flags']['optional'] extends false
    ? TFields[K]['_kind'] extends 'integer' | 'number'
      ? K
      : never
    : never;
}[keyof TFields];

type RequiredKeys<TFields extends DataFields> = Exclude<
  keyof TFields,
  OptionalKeys<TFields>
>;

export type DataRow<TTable extends DataTable<DataFields>> = {
  id: string;
  createdAt: string;
  updatedAt: string;
} & {
  [K in keyof TTable['fields']]: FieldValue<TTable['fields'][K]>;
};

export type DataInsert<TTable extends DataTable<DataFields>> = {
  [K in RequiredKeys<TTable['fields']>]: FieldValue<TTable['fields'][K]>;
} & {
  [K in OptionalKeys<TTable['fields']>]?: FieldValue<TTable['fields'][K]>;
};

export type DataPatch<TTable extends DataTable<DataFields>> = Partial<
  DataInsert<TTable>
>;

export type DataPatchOptions<TTable extends DataTable<DataFields>> = {
  unset?: readonly (UnsettableKeys<TTable['fields']> & string)[];
};

export type DataWhere = {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: JsonValue;
};

export type DataQuery = {
  table: string;
  index?: string;
  where?: DataWhere[];
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  cursor?: string;
  limit?: number;
};

export type DataQueryResult<TRow = Record<string, JsonValue>> = {
  items: TRow[];
  cursor: string | null;
  revision: number;
};

export type DataTableName<TSchema extends DataSchema> =
  keyof TSchema['tables'] & string;

export type DataQueryFor<
  TSchema extends DataSchema,
  TName extends DataTableName<TSchema>,
> = Omit<DataQuery, 'table'> & { table: TName };

export type DataQueryResultFor<
  TSchema extends DataSchema,
  TName extends DataTableName<TSchema>,
> = DataQueryResult<DataRow<TSchema['tables'][TName]>>;

export type DataMutation =
  | { type: 'insert'; table: string; value: Record<string, JsonValue> }
  | {
      type: 'patch';
      table: string;
      id: string;
      value: Record<string, JsonValue>;
      unset?: string[];
    }
  | {
      type: 'increment';
      table: string;
      id: string;
      field: string;
      amount: number;
    }
  | { type: 'delete'; table: string; id: string };

export type DataMutationResult = {
  results: Array<Record<string, JsonValue> | null>;
  revision: number;
};

export class DataRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DataRequestError';
  }
}

export type DataClient<TSchema extends DataSchema> = {
  /** Stable namespace used by framework adapters to isolate shared caches. */
  readonly cacheNamespace: string;
  query<TName extends DataTableName<TSchema>>(
    query: DataQueryFor<TSchema, TName>,
  ): Promise<DataQueryResultFor<TSchema, TName>>;
  get<TName extends keyof TSchema['tables'] & string>(
    table: TName,
    id: string,
  ): Promise<DataRow<TSchema['tables'][TName]> | null>;
  insert<TName extends keyof TSchema['tables'] & string>(
    table: TName,
    value: DataInsert<TSchema['tables'][TName]>,
  ): Promise<DataRow<TSchema['tables'][TName]>>;
  patch<TName extends keyof TSchema['tables'] & string>(
    table: TName,
    id: string,
    value: DataPatch<TSchema['tables'][TName]>,
    options?: DataPatchOptions<TSchema['tables'][TName]>,
  ): Promise<DataRow<TSchema['tables'][TName]> | null>;
  increment<
    TName extends keyof TSchema['tables'] & string,
    TField extends IncrementableKeys<TSchema['tables'][TName]['fields']> &
      string,
  >(
    table: TName,
    id: string,
    field: TField,
    amount: number,
  ): Promise<DataRow<TSchema['tables'][TName]> | null>;
  delete<TName extends keyof TSchema['tables'] & string>(
    table: TName,
    id: string,
  ): Promise<boolean>;
  transaction(operations: DataMutation[]): Promise<DataMutationResult>;
  watch<TName extends DataTableName<TSchema>>(
    query: DataQueryFor<TSchema, TName>,
    listener: (result: DataQueryResultFor<TSchema, TName>) => void,
    onError?: (error: unknown) => void,
  ): () => void;
};

function runtimeDeploymentId(): string | undefined {
  if (typeof __DATA_DEPLOYMENT_ID__ !== 'undefined' && __DATA_DEPLOYMENT_ID__) {
    return __DATA_DEPLOYMENT_ID__;
  }
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env?: { get(name: string): string | undefined } };
  };
  try {
    return runtime.Deno?.env?.get('HATCH_DEPLOYMENT_ID') || undefined;
  } catch {
    return undefined;
  }
}

async function hmacHeaders(secret: string, body: string): Promise<HeadersInit> {
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    'x-hatch-timestamp': timestamp,
    'x-hatch-signature': `sha256=${hex}`,
  };
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<DataRequestError> {
  return new DataRequestError(
    (await response.text()) || `${fallback} (${response.status})`,
    response.status,
  );
}

function isPermanentRequestError(error: unknown): boolean {
  return (
    error instanceof DataRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
}

export function createDataClient<TSchema extends DataSchema>(options: {
  baseUrl: string;
  signingSecret?: string;
  /** Defaults to the platform-injected browser constant or backend env value. */
  deploymentId?: string;
  /** Overrides the framework-cache namespace when one endpoint has partitions. */
  cacheNamespace?: string;
}): DataClient<TSchema> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const deploymentId = options.deploymentId ?? runtimeDeploymentId();
  const cacheNamespace =
    options.cacheNamespace ?? JSON.stringify([baseUrl, deploymentId ?? null]);

  const request = async <T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const raw = JSON.stringify(body);
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(deploymentId ? { [DATA_DEPLOYMENT_HEADER]: deploymentId } : {}),
        ...(options.signingSecret
          ? await hmacHeaders(options.signingSecret, raw)
          : {}),
      },
      body: raw,
      signal,
    });
    if (!response.ok) {
      throw await responseError(response, 'Data request failed');
    }
    return (await response.json()) as T;
  };

  const rawQuery = <TResult extends DataQueryResult>(
    input: DataQuery,
    signal?: AbortSignal,
  ) => request<TResult>('query', input, signal);

  const transaction = (operations: DataMutation[]) =>
    request<DataMutationResult>('mutate', { operations });

  return {
    cacheNamespace,
    query: (input) => rawQuery(input) as never,
    async get(table, id) {
      const result = await rawQuery<DataQueryResult>({
        table,
        where: [{ field: 'id', op: 'eq', value: id }],
        limit: 1,
      });
      return (result.items[0] ?? null) as never;
    },
    async insert(table, value) {
      const result = await transaction([
        { type: 'insert', table, value: value as Record<string, JsonValue> },
      ]);
      return result.results[0] as never;
    },
    async patch(table, id, value, options) {
      const result = await transaction([
        {
          type: 'patch',
          table,
          id,
          value: value as Record<string, JsonValue>,
          ...(options?.unset ? { unset: [...options.unset] as string[] } : {}),
        },
      ]);
      return result.results[0] as never;
    },
    async increment(table, id, field, amount) {
      const result = await transaction([
        { type: 'increment', table, id, field, amount },
      ]);
      return result.results[0] as never;
    },
    async delete(table, id) {
      const result = await transaction([{ type: 'delete', table, id }]);
      return result.results[0] !== null;
    },
    transaction,
    watch(input, listener, onError) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timerDeadline: number | undefined;
      let revision = 0;
      let refetching: Promise<'success' | 'retry' | 'permanent'> | undefined;
      let refetchAgain = false;

      const stopWatching = () => {
        abort.abort();
        clearTimeout(timer);
        timer = undefined;
        timerDeadline = undefined;
      };

      const refetch = (): Promise<'success' | 'retry' | 'permanent'> => {
        if (refetching) {
          // A change that arrives during a query must cause one more query after
          // the in-flight snapshot completes; merely sharing that promise can
          // otherwise acknowledge the event without ever reading its row.
          refetchAgain = true;
          return refetching;
        }
        const pending = (async () => {
          let outcome: 'success' | 'retry' | 'permanent' = 'retry';
          do {
            refetchAgain = false;
            try {
              const result = await rawQuery<DataQueryResult>(
                { ...input },
                abort.signal,
              );
              if (abort.signal.aborted) return 'retry';
              revision = Math.max(revision, result.revision);
              listener(result as never);
              outcome = 'success';
            } catch (error) {
              if (!abort.signal.aborted) onError?.(error);
              outcome = isPermanentRequestError(error) ? 'permanent' : 'retry';
              if (outcome === 'permanent') stopWatching();
            }
          } while (
            outcome === 'success' &&
            refetchAgain &&
            !abort.signal.aborted
          );
          return outcome;
        })();
        refetching = pending;
        void pending.finally(() => {
          if (refetching === pending) refetching = undefined;
        });
        return pending;
      };

      const scheduleRefetch = (delay: number) => {
        const deadline = Date.now() + delay;
        // Coalesce bursts without allowing sustained events to starve the
        // snapshot forever. A new event may accelerate a pending retry, but it
        // must never move an already scheduled refresh further into the future.
        if (
          timer !== undefined &&
          timerDeadline !== undefined &&
          timerDeadline <= deadline
        ) {
          return;
        }
        clearTimeout(timer);
        timerDeadline = deadline;
        timer = setTimeout(
          () => {
            timer = undefined;
            timerDeadline = undefined;
            void refetch().then((outcome) => {
              if (outcome === 'retry' && !abort.signal.aborted) {
                scheduleRefetch(1000);
              }
            });
          },
          Math.max(0, deadline - Date.now()),
        );
      };

      const wait = (delay: number) =>
        new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          const done = () => {
            clearTimeout(timeout);
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          const timeout = setTimeout(done, delay);
          abort.signal.addEventListener('abort', done, { once: true });
        });

      const stream = async () => {
        // Do not open a stream until the initial query succeeds. Opening both
        // retry paths after a failed query creates overlapping request loops and
        // can subscribe with a cursor that was never rendered.
        while (!abort.signal.aborted) {
          const outcome = await refetch();
          if (outcome === 'success') break;
          if (outcome === 'permanent') return;
          await wait(1000);
        }
        while (!abort.signal.aborted) {
          try {
            const headers = {
              ...(deploymentId
                ? { [DATA_DEPLOYMENT_HEADER]: deploymentId }
                : {}),
              ...(options.signingSecret
                ? await hmacHeaders(options.signingSecret, '')
                : {}),
            };
            const response = await fetch(
              `${baseUrl}/events?since=${revision}&table=${encodeURIComponent(
                input.table,
              )}`,
              {
                credentials: 'same-origin',
                headers,
                signal: abort.signal,
              },
            );
            if (!response.ok) {
              throw await responseError(response, 'Data stream failed');
            }
            if (!response.body) {
              throw new Error('Data stream returned no response body.');
            }
            const reader = response.body
              .pipeThrough(new TextDecoderStream())
              .getReader();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += value;
              const events = buffer.split('\n\n');
              buffer = events.pop() ?? '';
              for (const event of events) {
                if (
                  !event.split('\n').some((line) => line.startsWith('event:'))
                ) {
                  continue;
                }
                const id = event
                  .split('\n')
                  .find((line) => line.startsWith('id:'))
                  ?.slice(3)
                  .trim();
                const eventType = event
                  .split('\n')
                  .find((line) => line.startsWith('event:'))
                  ?.slice(6)
                  .trim();
                const eventRevision = Number(id);
                if (
                  id &&
                  Number.isSafeInteger(eventRevision) &&
                  eventRevision >= 0
                ) {
                  revision =
                    eventType === 'reset'
                      ? eventRevision
                      : Math.max(revision, eventRevision);
                }
                scheduleRefetch(30);
              }
            }
            // A clean EOF is still a transport disconnect. Back off before
            // reconnecting so a proxy returning empty streams cannot spin the
            // browser in a tight fetch loop.
            if (!abort.signal.aborted) await wait(1000);
          } catch (error) {
            if (abort.signal.aborted) return;
            onError?.(error);
            if (isPermanentRequestError(error)) {
              stopWatching();
              return;
            }
            await wait(1000);
          }
        }
      };

      void stream();
      return stopWatching;
    },
  };
}
