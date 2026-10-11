# Public platform API v1

The client-neutral HTTP/JSON API serves CLI, custom Agents and future Web clients.
`src/platform-api/contract.ts` defines the public contract independently of Runner
protocol. The TanStack Start `/api/v1/$` server route mounts the oRPC 1.15.5 Fetch
`OpenAPIHandler`. It dispatches, decodes, validates and transports errors; public
procedures directly call App/Workflow domain services, never server functions.
There is no additional RPC-only HTTP endpoint.

`GET /api/v1/openapi.json` generates OpenAPI 3.1 from the same contract, including
request/output DTOs, statuses, errors and authentication schemes. It is public
metadata and contains no credentials or internal procedures. `servers` uses
`/api/v1`; specification paths are relative to it. There is no hand-written spec.
Typed oRPC consumers can use `OpenAPILink` with this contract and HTTP surface:

```ts
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { platformApiContract } from '../src/platform-api/contract';

const client: ContractRouterClient<typeof platformApiContract> =
  createORPCClient(
    new OpenAPILink(platformApiContract, {
      url: 'https://hatch.example.com/api/v1',
      headers: { 'x-api-key': '<user-api-key>' },
    }),
  );
const apps = await client.apps.list({});
// Deploy path parameters and JSON body remain distinct in the typed contract.
await client.apps.deploy({
  params: { id: apps[0].id },
  body: {
    message: 'Release',
    generation: apps[0].createdAt,
    bundleBase64: '<git-bundle>',
  },
});
```

All DTOs are JSON-native, so this contract needs no additional date/bigint RPC
serialization.

## Authentication

Every valid Better Auth session (Cookie or Bearer session token), user API key
(`x-api-key`), or Agent Run JWT has full access to every public procedure, across
all Apps and Workflows. No scopes, roles or resource permissions exist. A Run's
session context only associates newly created Apps with that conversation.

Explicit `x-api-key` takes precedence, followed by explicit `Authorization`, then
Cookie. An invalid, empty or malformed explicit credential cannot fall back to a
valid Cookie. Keys must be enabled, unexpired, unrevoked and have an existing
owner. Run JWTs use Better Auth native signing/verification and must match the
live Run/session/Runner bindings, running/blocked status, lease and token expiry.
Run JWTs and keys are not Better Auth account sessions or fleet credentials.
Native `/api/auth/*` lifecycle and internal fleet HTTP/WS retain independent auth.

```sh
curl -H 'x-api-key: <user-api-key>' https://hatch.example.com/api/v1/apps
curl -H 'Authorization: Bearer <session-token-or-run-jwt>' \
  https://hatch.example.com/api/v1/workflows
curl -b 'better-auth.session_token=<signed-session-cookie>' \
  https://hatch.example.com/api/v1/apps
curl -X POST -H 'Authorization: Bearer <session-token-or-run-jwt>' \
  -H 'Content-Type: application/json' \
  --data '{"slug":"notes","name":"Notes"}' \
  https://hatch.example.com/api/v1/apps
```

For browser clients, same-origin access at the canonical `APP_URL` is supported.
No CORS headers or cross-origin credentialed preflight are provided. Requests
to authenticated procedures with a different `Origin` are denied; Cookie requests marked `Sec-Fetch-Site:
cross-site` are denied. Mutations require `application/json`, including with
Cookie auth; multipart, URL-encoded forms and text/plain are rejected before any
destructive domain action. Ordinary request bodies are capped at 16 KiB;
deployment bundle JSON at 256 MiB, counting actual bytes even without
Content-Length. All API responses are `no-store` with `nosniff` and `no-referrer`.

## URLs and DTOs

The never-deployed old public URLs are removed directly, with no aliases.
Unknown API URLs return JSON 404 rather than the global SPA shell.

| Method          | Removed URL                         | Current URL                     | Success |
| --------------- | ----------------------------------- | ------------------------------- | ------- |
| GET             | /api/cli/v1/apps                    | /api/v1/apps                    | 200     |
| POST            | /api/cli/v1/apps                    | /api/v1/apps                    | 201     |
| GET             | /api/cli/v1/apps/:id                | /api/v1/apps/:id                | 200     |
| GET             | /api/cli/v1/apps/:id/source         | /api/v1/apps/:id/source         | 200     |
| POST            | /api/cli/v1/apps/:id/deploy         | /api/v1/apps/:id/deploy         | 200     |
| POST            | /api/cli/v1/apps/:id/rollback       | /api/v1/apps/:id/rollback       | 200     |
| GET             | /api/cli/v1/workflows               | /api/v1/workflows               | 200     |
| POST            | /api/cli/v1/workflows               | /api/v1/workflows               | 201     |
| GET             | /api/cli/v1/workflows/:id           | /api/v1/workflows/:id           | 200     |
| GET             | /api/cli/v1/workflows/:id/source    | /api/v1/workflows/:id/source    | 200     |
| POST            | /api/cli/v1/workflows/:id/deploy    | /api/v1/workflows/:id/deploy    | 200     |
| POST            | /api/cli/v1/workflows/:id/rollback  | /api/v1/workflows/:id/rollback  | 200     |
| POST (internal) | /internal/api/cli/runs/:runId/token | /internal/api/runs/:runId/token | 200     |

The internal minting operation remains on the dedicated fleet-authenticated
Runner HTTP server and is absent from public contracts/specification. Its URL
rename has never shipped; Platform/Runner protocol stays at 18. All real
callers use the new path; no Agent environment token injection is added. The separately packaged CLI
consumes injected credentials and never mints them. App/Workflow compatibility constants and database schema stay unchanged.

IDs resolve exact immutable ID first, then slug. List/detail project only `id`,
`slug`, `name`, nullable `description`, `status`, ISO `createdAt`/`updatedAt`.
No raw rows, database credentials, webhook secrets or build logs are returned.

`GET /auth/status` projects the authenticated context: credential type (`session`,
`api-key`, `run`), full platform authority, verified expiry (nullable for keys),
minimal user/key metadata or Run binding. No token/session secret is returned.
`GET /sdk/{kind}` (`app`/`workflow`) returns compiled SDK/import-map files as
path/base64 pairs from this platform build and App codegen tool versions. These
small client-neutral additions share normal authentication/error policy and the
generated OpenAPI contract; no DB migration or Runner wire change is needed.
The [CLI](../packages/hatch-cli/README.md) uses OpenAPILink with request/response
validation and bundles the pure contract.
Create accepts `slug`, `name`, optional `description`/`pin`, and returns `id`,
`slug`, `name`, rendered `files` (`path`, `contentBase64`). Source returns `id`,
nullable `masterCommit` and `bundleBase64`. Decode the latter into a Git bundle
and clone it locally; commit changes and export a new bundle for deployment.

Deploy accepts `message`, `generation` (detail's `createdAt`), `bundleBase64`,
optional `allowDestructiveDataMigration` and `dataMigrationApprovalToken`.
The path ID is separate from the strict JSON body. It returns `deploymentId`,
`version`, `compatibilityVersion`. Domain services retain clean Git source,
fast-forward, manifest identity/compatibility, migration approval, cleanup and
serialized release safeguards. Generation is checked on entry and inside the
deploy lock. Successful source/master and deployment tags advance together.

Rollback accepts `{"version":1}` and returns `version`, `compatibility` (version,
latestVersion, minimumSupportedVersion, isSupported, isLatest), and, for Apps,
`dataSchemaMismatch`. It retains the existing version-restore semantics, including
the source recovery override for unsupported compatibility, artifact checks,
Data cutover locks, and migration fences. This behavior is identical for all
public credential types.

## Errors and validation

oRPC's standard error envelope is `{ "defined": boolean, "code": string,
"status": number, "message": string }`. Clients should branch on `code`, not
message text. Request schema errors use `BAD_REQUEST` (400); credentials use
`UNAUTHORIZED`, `INVALID_TOKEN` or `RUN_ENDED` (401); cross-origin requests use
`FORBIDDEN` (403); missing resources/routes use `NOT_FOUND` (404); domain conflicts
use `CONFLICT` or `RESOURCE_GENERATION_CONFLICT` (409); size and media failures
use `PAYLOAD_TOO_LARGE` (413) and `UNSUPPORTED_MEDIA_TYPE` (415). Unexpected
exceptions use `INTERNAL_SERVER_ERROR` (500), with no exception text or diagnostic
input data. Declared client-safe AppError messages remain available for non-5xx
business failures. Unsupported methods/paths return 404. JSON syntax errors are
400, and strict DTOs reject unknown body fields. The generated spec describes
actual endpoint methods, statuses and errors.

## Local verification

Use only disposable PostgreSQL and a private `HATCH_DATA_DIR`. Auth integration
is enabled by `HATCH_AUTH_TEST_DATABASE_URL`. Production-build lifecycle/security
integration is enabled by `HATCH_PLATFORM_TEST_DATABASE_URL` after `pnpm build`:

```sh
HATCH_AUTH_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/platform-api/auth.integration.test.ts
HATCH_PLATFORM_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/platform-api/lifecycle.integration.test.ts
```

These suites skip without their explicit database variable. They must never use
production credentials or share another task's runtime. No data migration or
backfill is part of this URL migration.
