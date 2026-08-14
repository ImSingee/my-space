# Data and storage

Read this reference when choosing among runtime assets, an App Postgres
database, managed Data Tables, Storage, or KV.

## Choosing a store

- Use `backend/assets/` for immutable files bundled with a deployment.
- Use managed Data Tables for typed CRUD, realtime queries, and automatic
  forward migrations without writing a backend.
- Use the App database for SQL, joins, aggregates, transactions, or ORM control.
- Use Storage for blobs and mutable files.
- Use KV for a small number of configuration values, tokens, or counters.

## Runtime assets

Deploy copies `backend/assets/` and injects its absolute path as
`HATCH_ASSETS_DIR`:

```ts
import path from 'node:path';

const assetsDir = Deno.env.get('HATCH_ASSETS_DIR')!;
const template = await Deno.readTextFile(
  path.join(assetsDir, 'email-template.html'),
);
```

Do not write there and do not locate assets through `import.meta.url`; bundled
modules share the emitted bundle URL.

## App Postgres database

Enable `database` and deploy successfully to provision the database. The backend
receives `DATABASE_URL` only while the capability is enabled; create required
tables idempotently on startup so a fresh deployment works. `query_app_db` can
inspect or initialize an already-provisioned database and can query it while
retained after capability disable, but never provisions or recreates one. Each
App database is isolated.

## Managed Data Tables

The main Skill contains the schema and typed-client contract. Additional query
and mutation behavior:

- Every table includes `id`, `createdAt`, and `updatedAt`.
- `.index(...)` creates a physical index; `.uniqueIndex(...)` also enforces
  uniqueness. Queries do not select an index by name.
- `data.patch(..., { unset: [...] })` clears optional fields to SQL `NULL`.
  Assigning `null` to a JSON field stores JSON null instead.
- `data.increment(...)` atomically updates a required integer/number field and
  returns `null` if the row no longer exists. Its raw mutation can participate
  in `data.transaction`.
- `data.watch(query, callback)` and `useDataQuery` from `@hatch/data/react`
  subscribe to realtime results.
- A backend creates the same typed client with `HATCH_DATA_URL` and
  `HATCH_SIGNING_SECRET`.

After deployment, use `query_app_data_table` for live data operations:

- `inspect` reports the live schema, defaults, indexes, schema hash, and row
  estimates. Inspect before querying when the live schema is unknown.
- `query` supports up to 16 AND-combined filters, ordering, and cursor
  pagination, returning at most 200 rows per page.
- `mutate` atomically applies up to 100 insert, patch, increment, or exact-id
  delete operations. One failed operation rolls back the batch.
- `raw_sql` is only for joins, aggregates, or complex repair that structured
  operations cannot express. It may use data-oriented SELECT, INSERT, UPDATE,
  DELETE, MERGE, CTE, join, aggregate, and upsert statements against existing
  `data` tables. Do not use DDL, TRUNCATE, maintenance, transaction-control,
  permission, role, database, or `_hatch` operations. Inspect first because
  physical column names are returned exactly as stored.

The current deployment must keep `capabilities.dataTable` enabled for App,
Agent, and Realtime access. Disabling it retains the managed database and latest
schema but revokes all access. Operations can permanently delete that retained
data; the next Data Table-capable release provisions an empty database and
applies its schema.

Use `data/schema.ts` plus `deploy_app` for every schema change.

## Storage

Enable both `storage` and `backend`. The backend receives a writable
`STORAGE_DIR` pointing at one private, persistent directory for the App. Keep
all mutable files below that directory and never write to `HATCH_ASSETS_DIR`.

```ts
import path from 'node:path';

const storageDir = Deno.env.get('STORAGE_DIR')!;
await Deno.writeTextFile(path.join(storageDir, 'state.json'), '{}');
```

Storage is backend-only: there is no Storage HTTP API and browser code cannot
access the directory directly. Files survive backend restarts, deployments,
and rollbacks. Disabling the capability revokes backend access without deleting
files; re-enabling it exposes the same contents. Deleting the App permanently
deletes its storage directory.

## KV

Enable both `kv` and `backend`. KV is kept in the platform database and is
suited to small text values, not blobs. Limits are 512 characters per key,
64 KB per value, and 1000 keys per App.

After the first KV-capable deploy, use `query_app_kv` to inspect or initialize
entries. Secret values are masked unless `reveal_secrets: true` is explicitly
needed; revealed values enter model context. Deletion is permanent.

The backend uses `HATCH_KV_URL` and signs each request with
`HATCH_SIGNING_SECRET`. The signature is HMAC-SHA256 over
`<timestamp>.<rawBody>`; GET and DELETE use an empty body.

```ts
import { createHmac } from 'node:crypto';

const kvUrl = Deno.env.get('HATCH_KV_URL')!;
const secret = Deno.env.get('HATCH_SIGNING_SECRET')!;

function sign(body: string) {
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    'x-hatch-timestamp': timestamp,
    'x-hatch-signature': `sha256=${signature}`,
  };
}

async function kvSet(key: string, value: string, secret?: boolean) {
  const payload = secret === undefined ? { value } : { value, secret };
  const body = JSON.stringify(payload);
  const response = await fetch(`${kvUrl}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...sign(body) },
    body,
  });
  if (!response.ok) throw new Error(`KV set returned ${response.status}.`);
}
```

`GET {HATCH_KV_URL}` lists `{ items }`; `GET .../<key>` reads; `PUT .../<key>`
upserts `{ value, secret? }`; `DELETE .../<key>` removes. Omitting `secret` while
updating preserves the current flag. A secret is hidden in management UI but
remains readable by the backend. Newly created or overwritten secrets are
encrypted at rest with the platform's stable `SECRET`; changing that platform
secret directly makes encrypted KV entries unreadable. This protects current
database storage, not plaintext returned to an authorized backend or explicit
Agent reveal, nor older backups.
