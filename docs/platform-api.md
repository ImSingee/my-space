# Public platform Connect API

CLI and native/mobile clients use the Connect API under `/api/rpc`.
The platform Web UI continues using TanStack Server Functions. User-deployed Apps
keep their existing, separate Connect services. Better Auth login, device grants,
polling and sign-out remain native HTTP endpoints under `/api/auth/*`.

The authoritative contract is
`packages/hatch-platform-api/proto/hatch/platform/v1/`.
`app.proto`, `workflow.proto`, `auth.proto` and `sdk.proto` own their respective
services and request/response messages. `lifecycle.proto` shares App/Workflow
resource and release messages; `file.proto` shares file payloads; `error.proto`
owns business error details. All files retain the `hatch.platform.v1` package.
The contract defines `hatch.platform.v1.AppService`, `WorkflowService`, `AuthService` and
`SdkService`. Both lifecycle services provide list, create, get, get-source,
deploy and rollback RPCs. Auth provides `GetStatus`; Sdk provides `GetSdk`.
There are no REST aliases or OpenAPI endpoint. Former `/api/v1/*`, including
`openapi.json`, and `/api/cli/v1/*` return JSON 404 rather than the SPA shell.

## Clients and code generation

Use the shared proto to generate clients for each language. TypeScript clients
use the committed descriptors in `packages/hatch-platform-api/gen/`:

```ts
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { AppService } from '../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';

const transport = createConnectTransport({
  baseUrl: 'https://hatch.example.com/api/rpc',
  useBinaryFormat: true,
  interceptors: [
    (next) => (request) => {
      request.header.set('x-api-key', '<user-api-key>');
      return next(request);
    },
  ],
});
const client = createClient(AppService, transport);
const { resources } = await client.listApps({});
```

RPC URLs follow `/api/rpc/hatch.platform.v1.<Service>/<Method>`. JSON and binary
Connect unary calls do not require HTTP/2. gRPC and gRPC-Web are not exposed by
this endpoint. Send `Connect-Protocol-Version: 1`. For example:

```sh
curl -X POST https://hatch.example.com/api/rpc/hatch.platform.v1.AppService/ListApps \
  -H 'Connect-Protocol-Version: 1' -H 'Content-Type: application/json' \
  -H 'x-api-key: <user-api-key>' --data '{}'
```

Run `pnpm platform-api:generate` after editing proto. Buf dependencies are locked
in `buf.lock`; generation maps Protovalidate descriptors to the existing npm
package instead of copying its generated sources. `pnpm platform-api:check`
checks Buf lint, proto formatting and generated-code consistency without editing
tracked files. CI runs this check. Future schema edits must preserve field
numbers and supported wire behavior; use Buf breaking checks against the
previous released contract and reserve removed field names/numbers.

## Validation and DTOs

Buf Protovalidate annotations are the public input validation source of truth.
The server applies `@connectrpc/validate` before invoking services. Rules cover
required strings, slug syntax/length, App name Unicode code-point length,
positive rollback versions, nonempty deployment bundles and allowed SDK kinds.
Protobuf decoding handles wire types. Unknown fields follow Protobuf evolution
rules. These rules do not reproduce the former Zod parsing or error messages.
Runner and Agent tool contracts retain their independent Zod validation.

Lists return a `resources` array. Resource metadata contains only public identity,
status and ISO timestamps. Optional fields have explicit presence; omitted and
explicit `false` remain distinguishable. Files and source bundles are bytes,
represented as base64 in Protobuf JSON. Missing source/bundle fields mean there
is no published source. The CLI projects messages into its existing JSON output
and workspace format, including nullable fields and base64 file contents.

IDs resolve exact immutable ID before slug. Domain services still enforce
resource existence, generation conflicts, Git cleanliness/fast-forward,
manifest compatibility, migration approvals, release locking and rollback
artifact/data fences. Deployment requests include the resource's observed
`createdAt` as `generation`, checked again under the deploy lock.

## Authentication and transport policy

Every valid Better Auth session (Cookie or Bearer session token), user API key
(`x-api-key`), or Agent Run JWT has full access to public procedures. There are
no added scopes or roles. A Run's context associates newly created Apps with
its conversation. `GetStatus` returns a credential oneof and safe user/key/Run
metadata, never secrets or raw account/session rows.

Explicit API key takes precedence over Authorization, then Cookie. Invalid,
empty or malformed explicit credentials cannot fall back to a valid Cookie.
Keys must be enabled, unexpired, unrevoked and have an existing owner. Run JWTs
must match live Run/session/Runner bindings, running/blocked status, lease and
expiry. They are not Better Auth account sessions or fleet credentials.
Internal fleet HTTP/WS remains separate.

Browser requests are same-origin only at canonical `APP_URL`. Foreign Origins
and Cookie-only `Sec-Fetch-Site: cross-site` requests are denied. No permissive
CORS headers/preflight are added. Ordinary request messages are capped at 16 KiB;
deploy messages at 256 MiB. Limits apply to actual received and decompressed
bytes, including chunked requests. Responses use `no-store`, `nosniff` and
`no-referrer`.

## Errors and recovery

Errors use the standard Connect envelope and canonical codes. Protovalidate
failures return `invalid_argument` with structured violations. The shared
`PublicError` detail preserves business `code` and logical `http_status` for CLI
classification. Connect HTTP status follows the protocol: for example, size
failures are `resource_exhausted` (429), with logical status 413 in the detail.
Unexpected errors and decoder failures do not expose exception or input text.

The CLI retains its exit codes, credential redaction, cancellation, timeouts and
redirect refusal. A deployment explicitly rejected by the platform can clear
its pending journal. Cancellation, timeout, network loss or an otherwise unknown
outcome retains the journal: inspect remote source/version before retrying.
Mutations are never automatically retried.

## Verification and release

Platform and CLI switch together. Old REST clients must upgrade; rollback
requires reverting the paired platform/CLI release. This change has no database
or historical App/Workflow migration and changes no deployed-App/Workflow
compatibility constant or Platform/Runner protocol version.

Use disposable PostgreSQL and a private `HATCH_DATA_DIR`, never production data.
After `pnpm build`, run:

```sh
HATCH_AUTH_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/platform-api/auth.integration.test.ts
HATCH_PLATFORM_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/platform-api/lifecycle.integration.test.ts
```

These suites skip without explicit database opt-in. A skipped suite is not
acceptance. The lifecycle suite exercises actual production routes and the
packaged CLI; auth coverage uses real Better Auth and Run credentials.
