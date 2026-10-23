# Public platform Connect API

CLI parity adds complete safe list/detail views, normalized releases and four
App RPCs: `QueryAppKv`, `QueryAppDataTable`, `QueryAppDb`, and
`AssociateAppSession`. Resource `view` and deployment `normalized` use Protobuf
Value to preserve the allowlisted neutral JSON DTOs, including explicit null,
false, zero and empty values. Basic resource fields remain available to native
clients. The CLI validates and exposes the complete view rather than dropping
inspection metadata. See [the fifteen-tool matrix](cli-tool-parity.md).

Data calls have the same 256 MiB bounded message ceiling as deployment; ordinary
calls retain 16 KiB. Connect counts streamed/decompressed bytes. Query KV and
Data Table `input` Values use the authoritative shared strict domain validation
in `src/platform-api/data-schemas.ts`; outer request IDs and required messages
use Protovalidate. Actions, pagination and domain size bounds are unchanged.
Arbitrary JSON data is never model-normalized. Data failures hide values and
credentials; migration approvals expose only their fingerprint and guidance.
SQL receives Connect's cancellation signal before awaited lookups/preflight and
cancels database execution before connection cleanup, with no automatic retry.

Association derives only from verified Run context and is idempotent. Other
credentials report `not-applicable`, with no invented session. App create,
clone/update, deploy and rollback associate automatically; Workflow does not.
App DB queries follow the current domain lifecycle: only already registered
databases are queried, under the lifecycle lock. Querying never provisions or
recreates a database.

CLI and native/mobile clients use the Connect API under `/api/rpc`.
The platform Web UI continues using TanStack Server Functions. User-deployed Apps
keep their existing, separate Connect services. Better Auth login, device grants,
polling and sign-out remain native HTTP endpoints under `/api/auth/*`.

The authoritative contract is
`packages/hatch-platform-api/proto/hatch/platform/v1/`.
`app.proto`, `workflow.proto`, `auth.proto`, `agent.proto` and `sdk.proto` own their respective
services and request/response messages. `lifecycle.proto` shares App/Workflow
resource and release messages; `file.proto` shares file payloads; `error.proto`
owns business error details. All files retain the `hatch.platform.v1` package.
The contract defines `hatch.platform.v1.AppService`, `WorkflowService`, `AuthService` and
`SdkService`, plus session-only `AgentService`. Both lifecycle services provide list, create, get, get-source,
deploy and rollback RPCs. Auth provides `GetStatus` and session-only
`CreateHandoff`; Sdk provides `GetSdk`.
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
(`x-api-key`), or Agent Run JWT has full access to the existing lifecycle, auth
status and SDK procedures. Interactive Agent methods, `CreateHandoff`, and the
legacy `CreateAppHandoff`
require a Better Auth user session; API keys and Run JWTs receive
`permission_denied` with `SESSION_REQUIRED`, even alongside a valid Cookie.
There are no added scopes or roles. A Run's context associates newly created Apps with
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
CORS headers/preflight are added. Interactive methods preserve the existing
session origin policy: canonical `APP_URL` or the current trusted Tailscale
origin, and no `Sec-Fetch-Site: cross-site` request even with an explicit token.
Ordinary request messages are capped at 16 KiB;
deploy messages at 256 MiB. Limits apply to actual received and decompressed
bytes, including chunked requests. Responses use `no-store`, `nosniff` and
`no-referrer`.

## Interactive Agent and App resources

These client-neutral resources extend the shared `hatch.platform.v1` contract.
There is no mobile service, duplicate App projection, REST alias, oRPC contract,
or OpenAPI document. Native clients reuse `AppService/ListApps` (`{resources}`)
and `GetApp` (`{resource}`), including their exact-ID-before-slug resolution.

All methods below are Connect unary POSTs beneath `/api/rpc/hatch.platform.v1.`
and require Cookie or session Bearer. Request fields are validated with Buf
Protovalidate and the ordinary 16 KiB limit. Protobuf unknown-field evolution
rules replace the retired strict JSON DTOs; only declared fields influence
behavior. Empty repeated/default scalar fields may be omitted in Protobuf JSON;
generated clients restore defaults. Optional fields retain presence rather than
REST `null`. Timestamps remain ISO strings.

| Service/method                 | Input                                                                                      | Output and reuse                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentService/GetModelCatalog` | Empty message                                                                              | `{providers, defaultModel?}` containing enabled provider/model IDs, labels, reasoning flag and token/context limits. No provider keys or base URLs. Read-only, without provider-management side effects.                                                                                       |
| `AgentService/ListSessions`    | Optional `appId` (1–200 characters)                                                        | `{sessions}` newest first; each includes `id`, `title`, `appIds`, optional `providerId`/`modelId`, `messageCount`, `updatedAt`. Reuses the browser store and association filter.                                                                                                               |
| `AgentService/CreateSession`   | Optional `title` (≤200 characters), `providerId`/`modelId` (1–200 characters when present) | `{id}`. Blank title becomes `New chat`; omitted models remain unset. Availability is checked when a run starts.                                                                                                                                                                                |
| `AgentService/GetSession`      | `id` (1–200 characters)                                                                    | `{session}` with transcript `google.protobuf.Value` messages, optional `activeRun`, run timings, `updatedAt` Retry CAS and `serverTime`. One repeatable-read snapshot; pending questions/environment requests and `answeredAskId` preserve reconnect behavior. Missing session is `not_found`. |
| `AuthService/CreateHandoff`    | Required `target` oneof: `app: {id}` or `dashboard: {id}`; immutable resource IDs          | `{url, ticket, expiresAt, targetPath}`. Rechecks the resource before issuance and consumption. No caller-supplied URL or path; unknown JSON fields fail. See [browser handoffs](browser-handoffs.md).                                                                                          |
| `AppService/CreateAppHandoff`  | App `id` or slug (1–191 characters)                                                        | Deprecated compatibility adapter to the same handoff service. Existing response fields, ID-first lookup and App embed destination remain supported.                                                                                                                                            |

### Native authentication and one-use browser handoff

Login/device/logout retain Better Auth's existing HTTP contract. Native callers
use `/api/auth/device/code` and `/api/auth/device/token` with
`client_id: "hatch-mobile"`; `/cli/authorize` labels the request **Hatch Mobile**.
Open only the same-instance verification URL in the system browser, honor polling
intervals and pending/slow-down/denied/expired results, and keep the returned
session token in secure storage scoped to the exact instance origin.

The only added native auth transport is
`POST /api/auth/handoffs/consume`: exactly one URL-encoded `ticket` form field,
maximum 1 KiB, no substitute Cookie/API key/Bearer authorization. Successful
consumption returns a 303 to the server-computed App embed or Dashboard path and sets a signed,
host-only HttpOnly cookie for the **original session**. This form/redirect flow
cannot be represented by a unary RPC. Other methods receive 405. Errors are
plain HTTP JSON; no Connect request or header is required for this endpoint.

Open the form POST in an incognito WebView after validating its origin and
fixed consume path. The random capability expires within 60 seconds or original
session expiry, whichever is earlier. Only its SHA-256 identifier and bounded
session/typed-resource/origin binding are stored in the existing verification table. Atomic
DELETE RETURNING prevents reuse across consumers. Consumption rechecks original
session revocation, the exact trusted origin and resource availability. Apps
also recheck slug, frontend deployment and compatibility; Dashboards recheck
existence. Sign-out/revocation ends pending tickets and WebView sessions.
There is no token URL, arbitrary redirect, JavaScript credential bridge, new
long-lived credential or permission scope. Responses are no-store and no CORS
permissions are added.

For request examples, the existing Dashboard destination, legacy ticket
compatibility and rolling-deployment order, see [browser handoffs](browser-handoffs.md).

### Existing Agent run transport

The native client continues reusing the existing session-authenticated HTTP
transport. Explicit invalid Bearer never falls back to Cookie; API keys, Run
JWTs and cross-site requests cannot enter this interactive boundary.

| Method/path                                                      | Existing contract                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/agent/runs`                                           | Session/model IDs, composer text, optional images/attachments or revision-guarded Retry; returns run identity.                                                         |
| `GET /api/agent/runs/{runId}/events?after=N`                     | SSE `{seq,event}` and persistent replay.                                                                                                                               |
| `POST /api/agent/runs/{runId}/answer`                            | `{askId, answers}`, saved once; duplicates/concurrent submissions conflict. Snapshot `answeredAskId` covers pending Runner acknowledgement.                            |
| `POST /api/agent/runs/{runId}/cancel`                            | Existing cancellation behavior.                                                                                                                                        |
| `PUT /api/agent/sessions/{sessionId}/attachments/{attachmentId}` | Raw bytes, Content-Type and percent-encoded X-Attachment-Name; 25 MiB per-file limit, idempotent attachment ID, combined six-file and 25,000,000-byte run-body limits. |

### Migration and release order

Deploy this backend before the rebased native client. The unshipped generic-v1
interactive endpoints and `/api/mobile/v1` are removed without aliases. An old
client must upgrade; the new client never falls back to Server Functions or API
keys when `GetModelCatalog` is unavailable. Previously issued handoff tickets
expire within 60 seconds; request a fresh ticket after upgrading. There is no
schema/backfill or Platform/Runner/App/Workflow compatibility version change.
Rollback pairs backend and client revisions and leaves ordinary session
revocation available. Historical SDK58/generic-v1 native acceptance does not
verify this Connect migration; its checks are unit/contracts, type checks and
builds only.

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
