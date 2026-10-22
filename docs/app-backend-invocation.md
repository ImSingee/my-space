# Invoke an App backend

`hatch app invoke backend` calls an already deployed App method using Connect
unary JSON. The App's own service contract defines the request and response;
local generated App stubs or a proto compiler are unnecessary.

```sh
hatch app invoke backend <id-or-slug> app.v1.TodoService/ListTodos --json
hatch app invoke backend <id-or-slug> app.v1.TodoService/CreateTodo --file request.json --json
cat request.json | hatch app invoke backend <id-or-slug> app.v1.TodoService/CreateTodo --file - --json
hatch --profile staging app invoke backend <id-or-slug> app.v1.TodoService/ListTodos --json
```

Without `--file`, the request is `{}`. Files and stdin must contain valid JSON,
up to 1 MiB. Input bytes are preserved, including whitespace, Unicode and
meaningful `null`, `false`, zero, arrays and empty values when the App message
supports them. Relative input paths resolve under `--workdir` (the current
working directory by default). Invalid JSON and invalid method paths fail before
any request is sent. The backend remains responsible for its Protobuf schema.

Method paths use Protobuf identifiers: `package.Service/Method` (an unpackaged
`Service/Method` is also valid). URLs, encoded separators, traversal, query strings
and fragments are rejected. The CLI resolves the ID or slug through the public
Platform management API, then calls the canonical App ID at the selected origin:

```text
POST /api/app/<appId>/rpc/<package.Service>/<Method>
Content-Type: application/json
Connect-Protocol-Version: 1
```

## Credentials

Use the existing login profile, a user API key profile, or a complete environment
credential pair. Environment credentials take precedence over file profiles;
combining them with `--profile` is an error. A partial or invalid environment pair
never falls back to a saved profile.

- `HATCH_CLI_URL` and `HATCH_CLI_TOKEN`: a native Better Auth session token or an
  externally supplied, live Better Auth Run JWT.
- `HATCH_CLI_URL` and `HATCH_CLI_API_KEY`: a user API key.

Exactly one credential variable is required with `HATCH_CLI_URL`. Use an HTTPS
origin; HTTP is allowed only for localhost, 127.0.0.1 or ::1. Credentials remain
bound to this origin. Run credentials are environment-only and are never saved
as login profiles; the CLI neither mints nor renews them.

The runtime RPC endpoint also supports native browser Cookie sessions. Its
shared credential validator checks `x-api-key` first, then an explicit Bearer
credential, then Cookie authentication. Invalid or empty explicit credentials
are denied even when a valid Cookie is present. Key expiry/revocation/owner
existence and Run signature, expiry, live status, session/Runner binding and
lease are checked by the existing native validators. Cross-origin browser calls
remain denied; no third-party CORS permission is added.

This grants the existing platform authority, with no new roles, scopes or
resource ACLs. Session-only Agent management RPCs still require a real user
session. API keys do not become Better Auth sessions.

## Responses, errors and cancellation

Successful output is the App JSON result itself. `--json` emits one compact JSON
value on stdout with no progress text. Connect failures exit nonzero and report
`ok: false` with the Connect code, message, HTTP status and original error JSON
under `error.response`. Selected platform credential strings are redacted from
error diagnostics. Structured App error details remain available.

The CLI supports unary JSON only. Framed Connect streams, gRPC-Web, native gRPC,
non-JSON and invalid JSON responses are reported as unsupported or invalid;
they cannot be mistaken for a successful JSON result. The runtime's existing
Connect/gRPC-Web and server-streaming proxy behavior remains available to direct
clients, including binary and per-message compression.

`--timeout <seconds>` defaults to 30 and accepts a positive value up to 3600.
SIGINT/SIGTERM and timeouts cancel the HTTP request. Redirects are never followed.
There are no automatic retries: after a timeout, cancellation or network failure,
a mutating App method may already have run. Inspect App state before retrying.

## Runtime boundary

Only a live, non-archived App deployment with the backend capability and a
supported App compatibility version can run. The deployment ID fence remains
in the cold-start path. Signed request bodies retain their existing 1 MiB limit
and exact-byte HMAC semantics. App responses are streamed through without a
management API envelope. Startup/proxy failures return safe Connect diagnostics.

On authenticated backend forwarding, Cookie, Authorization, platform API keys,
client-supplied `x-hatch-*`, forwarding and hop-by-hop headers are removed; the
platform supplies fresh per-App HMAC headers. Credentials never enter the App
subprocess environment.

Webhook mode-specific authentication and forwarding are owned by a separate
change. Authorization and x-api-key must not be used for App-private webhook
authentication; the required webhook policy strips both in every mode. This
backend-only change does not implement that webhook policy, a webhook invocation
command, or a new Invoke management API.

No database migration, public proto change, App/Workflow compatibility bump or
Runner protocol bump is required.

## Local verification

The durable runtime contract tests use migrated PGlite, real Better Auth and a
sandboxed Deno Connect fixture:

```sh
pnpm test:unit src/server/apps/runtime-api/rpc.integration.test.ts
```

The installed-package suite requires a fresh disposable PostgreSQL database and
Deno. It builds a private App artifact, installs the local CLI tarball outside the
repository and starts the production Platform on unused loopback ports. Never
point this verification variable at a user or production database.

```sh
pnpm build
HATCH_INVOKE_TEST_DATABASE_URL=<disposable-postgres-url> pnpm test:unit packages/hatch-cli/src/invoke.integration.test.ts
```

The suite covers external credential sources, canonical ID resolution, raw JSON,
Connect failures, protocol rejection, redirects, timeout/cancellation and help.
It stops its own Platform/backend processes and deletes its temporary files.
The caller owns the disposable database/container and must remove it afterward.
