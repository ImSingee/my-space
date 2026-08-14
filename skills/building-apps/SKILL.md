---
name: building-apps
description: Design, build, validate, and deploy Hatch Apps with React frontends, Connect/Deno backends, widgets, managed Data Tables, storage, integrations, and userscripts. Use whenever creating, modifying, debugging, or deploying an App.
---

# Build a Hatch App

Load this Skill before calling App platform tools or editing an App. Follow the
workflow in order and load only the capability references needed for the task.

## Core workflow

1. For a new App, call `list_apps` and use existing `slug · name` pairs to match
   the user's naming style. Ask for the name and slug in two separate `ask`
   calls, name first. Explain that both can be changed later. After both are
   confirmed, call `create_app`; pin user-facing Apps and leave backend-only or
   widget-only Apps unpinned.
   The slug is the human-facing `/app/<slug>` segment. Hatch generates a
   separate immutable id for the repository, data relations, and technical
   `/api/app/<id>/...` URLs.
2. For an existing App, inspect it with `list_apps` and `get_app`, then call
   `checkout_app`. The returned absolute source path is authoritative. Reuse an
   existing target or choose a different `target_path`; use `force: true` only
   when discarding that target is intended.
3. Read the actual source tree before editing. Keep `manifest.json`, proto,
   backend, frontend, widgets, userscripts, and capabilities synchronized.
4. If dependencies changed, update the lockfile with the Deno command below.
   Generate RPC code, run the source check, and run relevant tests.
5. In the returned worktree, inspect `git status`, stage only intended authored
   files, and commit. Do not push branches or create/push tags.
6. Call `deploy_app` with the same `source_path` and a concise release `message`.
   Deploy repeats source validation before building or changing durable
   deployment state. Fix any failure, validate again, commit, and redeploy.
7. Call `get_app` to confirm the deployed state, then explain how to open it.

If deploy says `master` advanced, refresh the same checkout, run
`git fetch origin master`, rebase onto `origin/master`, resolve conflicts, and
retry. Checkout never authorizes silently replacing local work.

## Source contract

`create_app` produces a prepared, runnable Counter App:

```text
manifest.json          App entries, capabilities, routes, widgets, integrations
proto/service.proto    Connect RPC service; proto files stay under proto/
backend/main.ts        bundled Deno backend
backend/assets/        optional read-only runtime assets
app/index.html         SPA host
app/main.tsx           React SPA entry
data/schema.ts         managed Data Table schema
widgets/counter.tsx    default demo widget
userscripts/*.ts       optional Tampermonkey entries
package.json           npm dependencies resolved by Deno
deno.json              compiler and lifecycle-script deny policy
deno.lock              committed dependency lock
buf.yaml
buf.gen.yaml
gen/service_pb.ts      generated and ignored
.hatch/                platform-owned SDK and import map; generated and ignored
```

Create and checkout prepare dependencies, run trusted Buf codegen, and
materialize `.hatch/` before returning. Treat the `.hatch` path segment as
reserved case-insensitively; never create spelling variants such as `.HATCH`.
Never edit or commit `.hatch/`, `gen/`, or `node_modules/`. Do not place an App
entry inside `.hatch/`. Do not create a root `.npmrc` in any casing; Hatch owns
App registry configuration. Use only the canonical root `deno.json`; do not
create `deno.jsonc`, `tsconfig.json`, or `jsconfig.json`.

Keep the App module and compiler contract fixed: `package.json` declares
`"type": "module"`; `deno.json` sets `compilerOptions.strict` to `true`,
`compilerOptions.jsx` to `"react-jsx"`, and `compilerOptions.jsxImportSource`
to `"react"`. Do not add `imports`, `scopes`, `importMap`, or `workspace` to
`deno.json`. Use explicit relative imports and registry dependencies from
`package.json` instead.

The public SDK mappings are generated in `.hatch/import-map.json`. Do not add
`@hatch/*` packages to `package.json` or `deno.lock`; Hatch owns their version
and materialization. The authoritative declaration entry for `@hatch/data` is
the `exports` map in `.hatch/sdk/@hatch/data/package.json`.

Buf generates `gen/service_pb.ts` from `proto/service.proto`. Never author
generated RPC code. Every relative TypeScript import must state its `.ts` or
`.tsx` extension:

```ts
import { TodoService } from '../gen/service_pb.ts';
import schema from '../data/schema.ts';
```

Do not enable unstable Deno import resolution.

Deploy bundles each enabled entry and its static imports. Source files,
dependency metadata, installed modules, `.hatch/`, and `gen/` do not become
runtime files. Only `backend/assets/` is copied beside the backend bundle; read
it through `HATCH_ASSETS_DIR`. Put mutable files in Storage instead.

## Persistent Storage

For mutable files, enable both `capabilities.backend` and
`capabilities.storage`. Hatch creates one fixed private directory for the App
and injects its absolute path into the backend as `STORAGE_DIR`. Read and write
only within that directory; never write to `HATCH_ASSETS_DIR`.

Storage is backend-only and has no frontend or widget HTTP API. Its contents
survive backend restarts, deployments, and rollbacks. Turning the capability
off revokes backend access but preserves the files; turning it back on exposes
the same contents. Deleting the App permanently deletes the directory.

## Manifest

Keep every declaration consistent with its source file. A representative
manifest is:

```json
{
  "id": "generated-app-id",
  "name": "Todo",
  "description": "A simple todo list",
  "version": 1,
  "capabilities": {
    "database": false,
    "frontend": true,
    "widgets": true,
    "backend": true,
    "cron": false,
    "webhook": false,
    "storage": false,
    "kv": false,
    "dataTable": false,
    "userscripts": false
  },
  "backendMode": "serverless",
  "rpc": {
    "proto": "proto/service.proto",
    "service": "app.v1.TodoService"
  },
  "backend": { "entry": "backend/main.ts" },
  "app": {
    "entry": "app/main.tsx",
    "html": "app/index.html",
    "routes": [{ "path": "/", "description": "Todo list" }]
  },
  "widgets": [
    {
      "id": "counter",
      "name": "Counter",
      "entry": "widgets/counter.tsx",
      "defaultSize": { "w": 4, "h": 3 }
    }
  ]
}
```

Use the generated immutable App id. `rpc.service` is the fully qualified proto
service name. Each `app.routes` item is discoverability metadata and uses
TanStack Router `$param` syntax for dynamic paths. Widget ids are stable URL and
dashboard identifiers.

## Dependencies

Deno is the only App package manager. Add normal semver dependencies to
`package.json`; never run npm or pnpm. After every dependency change, run from
the App root:

Apps deploy as standalone source trees. Do not use package/deno workspaces or
`file:`, `link:`, `workspace:`, absolute-path, or parent-directory dependencies;
publish or select a registry package version instead.
Use registry npm dependencies declared in `package.json`; do not import
`http:`, `https:`, or `jsr:` modules from App source.

```bash
deno install --package-json --node-modules-dir=auto --lock=deno.lock
```

Commit `package.json`, `deno.json`, and `deno.lock`. Deploy repeats installation
with `--frozen` and rejects stale dependency state.

Deno skips npm lifecycle scripts by default. App preparation and deploy do not
execute package `preinstall`, `install`, or `postinstall` code, even when a
package version has been audited. Keep `deno.json` `allowScripts` empty. If a
dependency needs a lifecycle script, native addon, FFI build, downloaded
binary, or runtime sidecar, replace it with a dependency that installs without
those mechanisms.

## Local validation

Create and checkout already generate RPC code. After changing a proto, regenerate
it from the App root with Hatch's platform-owned template. Do not run bare
`buf generate`: that reads the App-authored `buf.gen.yaml` instead.

```bash
buf generate --template .hatch/buf.gen.yaml
```

Then type-check every enabled entry from `manifest.json`, plus `data/schema.ts`
when Data Tables are enabled:

```bash
deno check --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen \
  app/main.tsx backend/main.ts widgets/counter.tsx data/schema.ts
```

Adjust the final entry list to the manifest; include userscript entries and omit
disabled or absent entries. Run relevant tests after the check. Do not use a
different import map for local checks.

Every other Deno command that resolves App TypeScript must use the same SDK,
node-modules, and frozen-lock contract. For example:

```bash
deno test --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <test paths...>
deno run --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <permission flags...> <entry.ts>
deno cache --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <entries...>
```

`deploy_app` performs the same source check before schema evaluation, production
bundling, database migration, artifact persistence, or live-release activation.
Its later bundle check verifies the emitted artifact and does not replace the
source check. A failed source check must be fixed in authored source and
committed before retrying deploy.

## Managed Data Tables

Use `capabilities.dataTable` for typed CRUD that does not need arbitrary SQL,
joins, or aggregates. It works without a backend and provides automatic
forward migrations plus realtime queries.

```ts
import { defineSchema, defineTable, t } from '@hatch/data';

export default defineSchema({
  todos: defineTable({
    title: t.string(),
    completed: t.boolean().default(false),
    metadata: t.json().optional(),
  }).index('by_completed', ['completed']),
});
```

```ts
import schema from '../data/schema.ts';
import { createDataClient, type JsonValue } from '@hatch/data';

declare const __DATA_BASE_URL__: string;
export const data = createDataClient<typeof schema>({
  baseUrl: __DATA_BASE_URL__,
});

const metadata: JsonValue = { source: 'app' };
await data.insert('todos', { title: 'Ship it', metadata });
```

Preserve the SDK's schema inference and public types. Do not delete the schema
generic, copy SDK declarations into App source, replace types with `any`, or add
casts to conceal an SDK-resolution or type error. Resolve API declarations
through `.hatch/sdk/@hatch/data/package.json` exports.

Tables include `id`, `createdAt`, and `updatedAt`. Use `renamedFrom(...)` for
renames, add indexes for frequent filters/orderings, use `unset` to clear an
optional field to SQL `NULL`, and use `increment` for atomic arithmetic on
required numeric fields. Use `data.watch` or `useDataQuery` from
`@hatch/data/react` for realtime results. Backends use `HATCH_DATA_URL` and
`HATCH_SIGNING_SECRET` with the same typed client.

Dropping tables/fields or narrowing types returns a destructive migration
preview without changing data. Obtain explicit user approval, then retry with
`allow_destructive_data_migration: true` and the exact returned approval token.
Tokens are bound to one preview and must not be reused after source changes.

After the first Data Table-capable deploy, use `query_app_data_table` to inspect
and manage live data. Inspect an unknown schema first, then prefer structured
`query` and atomic `mutate` operations. The `raw_sql` action is a dangerous last
resort for joins, aggregates, or complex data repair that structured actions
cannot express. Raw SQL may query or modify rows in existing `data` tables, but
it must not perform DDL, `TRUNCATE`, maintenance, transaction control,
permission, role, database, or `_hatch` operations. The platform does not
enforce that SQL rule, so the Agent must obey it. Schema changes always go
through `data/schema.ts` and `deploy_app`.

For arbitrary SQL, joins, aggregates, or ORM control, enable `database`, use
`query_app_db` while developing, and create tables idempotently on backend
startup. Each App database is isolated.

## KV secrets

Newly created or overwritten KV values marked `secret` are encrypted at rest
with the platform's stable `SECRET` and masked from ordinary Agent/UI reads.
Values written before encryption remain plaintext until overwritten; reading
does not migrate them. Changing `SECRET` makes encrypted values unreadable, and
older backups may still contain plaintext. When updating a KV value, omit the
`secret` property to preserve its existing flag.

## Capability references

Read only the reference relevant to the requested capability:

- [Frontend and widgets](references/frontend-widgets.md): React Router/Query,
  Connect clients, responsive widget sizing, and refresh behavior.
- [Backend integrations](references/backend-integrations.md): Connect backend,
  cron authentication, webhooks, long-running mode, and workflow calls.
- [Data and storage](references/data-storage.md): Postgres, Storage, KV, runtime
  assets, and Data Table query/mutation details.
- [Userscripts](references/userscripts.md): Tampermonkey manifest fields,
  metadata ownership, bundling, and cross-origin calls.

## Rollback

Use `get_app` to inspect successfully deployed versions and `rollback_app` with
the selected version. Rollback changes platform `master`, not an existing Agent
worktree. Refresh its checkout and rebase before making further changes.
Rollback restores code but never runs a Data Table down migration.
