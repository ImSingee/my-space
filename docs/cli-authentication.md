# CLI authentication

The installable CLI implements device/headless login, local profiles, native API key authentication, online status and explicit logout semantics. See [CLI README](../packages/hatch-cli/README.md) for env/config source priority, commands, safety, packaging and SDK preparation. `hatch.platform.v1.AuthService/GetStatus` reuses public API credential validation and projects safe session/key/Run metadata; it never accepts a locally decoded JWT as proof. CLI environment mode never persists credentials or reads `AGENT_RUNNER_TOKEN`.

How scripts, the future `hatch` CLI and Agent Runs authenticate to the platform.
The platform provides device authorization, user-managed API keys and Run JWTs;
it does not implement the CLI, profile storage, environment injection or changes
to Agent Tools/Skills.
Platform/Runner protocol stays at **18**; App and Workflow compatibility
constants and source/deployment/data contracts are unchanged.

## Model

| Credential         | How it is obtained                                 | Lifetime                                     | Authority                          |
| ------------------ | -------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| CLI session        | Device login, approved by a signed-in browser user | Better Auth session (7 days, renewed on use) | Same as a browser session          |
| API key            | Settings → Account, created by its signed-in owner | User-selected expiry or no expiry; revocable | All public platform API procedures |
| Run token (JWT)    | Trusted Runner, for a live Agent Run               | 5 minutes, only while the Run is live        | All public platform API procedures |
| Runner fleet token | Deployment operator                                | Existing configuration                       | Trusted internal REST/WS only      |

There are no scopes or resource permissions: a CLI session is a full
Better Auth session, and a Run token or API key can call every public platform API procedure.
The platform remains single-tenant: authenticated callers can manage all Apps
and Workflows. Key ownership controls credential management, not resource access.

## API keys for scripts

Open **Settings → Account → API keys**, give the key a name, and select its
lifetime (or no expiration). Save the full value from the creation dialog; it
is displayed only once and cannot be recovered after closing. The list contains
only the name, a partial masked identifier, creation/expiration and last-use
timestamps. Revoke ends the key immediately and removes it from the list.
Expired keys are rejected and may be removed by the plugin's expiration cleanup.

The Account UI passes `hatch_` as its creation prefix. Native API callers may
choose another prefix or omit it; CLI authentication delegates validity to the
plugin without checking a prefix, length or character pattern. Send keys only
in **`x-api-key`**, never in
a URL or `Authorization: Bearer`. Bearer retains its existing device session
and Run JWT meaning. When `x-api-key` is present it takes precedence; an invalid,
expired, disabled, orphaned or revoked key fails with 401 even if another valid
credential accompanies it. API keys are accepted by `/api/rpc` and do
not authenticate Settings, Better Auth or internal Runner APIs. Public App data
RPCs accept the same native credentials as lifecycle RPCs; secret KV values
require explicit reveal. App association derives from verified Run context only.

For example, with an API key already provided in the process environment:

```sh
curl --fail --silent --show-error \
  --header "x-api-key: ${HATCH_API_KEY}" \
  -X POST -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
  --data '{}' https://hatch.example.com/api/rpc/hatch.platform.v1.AppService/ListApps
```

`HATCH_API_KEY` is an example script variable, not a new platform configuration
or implemented CLI option. Do not enable shell tracing or verbose HTTP logging
for calls containing credentials. For CLI authentication, see `HATCH_CLI_API_KEY`
and `hatch auth login --api-key-file` in the [CLI README](../packages/hatch-cli/README.md).

The server uses the official `@better-auth/api-key` **1.7.7** plugin with its
default hash storage ([plugin documentation](https://www.better-auth.com/docs/plugins/api-key)).
Every verification reads PostgreSQL; there is no key
lookup cache, secondary storage or API-key session emulation. Usage updates are
awaited. Revocation deletes the owner-scoped row, so requests begun after the
revoke response cannot authenticate it; a request authorized before revocation
may finish. API keys deliberately have no extra quota/rate limit or scopes.

Management uses Better Auth's native `/api/auth/api-key/*` endpoints:

- `GET /list` returns `{ apiKeys, total, limit, offset }`.
- `POST /create` accepts, for example,
  `{ "name": "Automation", "expiresIn": 2592000, "prefix": "hatch_" }`.
  Lifetime is in seconds (1–315360000), or `null` for no expiry. The response
  contains metadata and the one-time raw `key` at the top level.
- `GET /get?id=…`, `POST /update` and `POST /delete` use the plugin's native
  contracts. Delete accepts `{ "keyId": "…" }`. The UI uses list/create/delete;
  native update remains available to the owner, including changing expiry or
  enabled status.

The plugin requires an ordinary session and checks user ownership. API keys do
not become sessions and cannot manage keys on their own. If a Cookie/session
accompanies an API key, that session supplies the management identity; another
user's key is still inaccessible. Client requests cannot supply a different
`userId` or server-only permissions/quota settings. Existing session Bearer
credentials retain their ordinary management authority. Verify and expired-key
cleanup methods remain server-only, without public HTTP routes.

The auth route sends `Cache-Control: no-store`. Native list/get responses omit
the `key` field; only create returns the raw key. The UI uses the standard Better
Auth client and inferred response types, and holds the secret in transient
component memory, outside query/mutation caches and browser persistence.

The locked 1.7.7 API key plugin has a local pnpm patch: its list implementation
must collect every owner record before configuration filtering and public
pagination. The Better Auth adapter otherwise defaults an omitted internal
limit to 100, causing the native endpoint to truncate both the list and `total`.
The patch uses the owner record count as an explicit internal fetch limit
instead of relying on the adapter default. Native list parameters and credential
management remain unchanged; the UI requests the complete list. Keep the patch
until an upstream version passes `src/auth/api-key-pagination.test.ts` without it.

## Device login (CLI sessions)

The CLI uses Better Auth's device authorization plugin unchanged
(`src/auth/server.ts`), with client ID `hatch-cli`, a 10-minute grant and a
5-second polling interval:

1. `POST /api/auth/device/code` with `{"client_id":"hatch-cli"}` returns the
   device code, user code and `verification_uri_complete`
   (`<APP_URL>/cli/authorize?user_code=…`).
2. The person opens that page, signs in with the existing `/login` if needed and
   approves or denies (see below).
3. The CLI polls `POST /api/auth/device/token` (RFC 8628 body). On approval it
   receives an ordinary session token as `access_token`.
4. The CLI sends `Authorization: Bearer <token>`. The `bearer` plugin turns it
   into the session, so the public platform API and every other session-protected endpoint
   accept it. `POST /api/auth/sign-out` with the same header ends it.

Better Auth owns the grant table (`device_code`) and its lifecycle: polling
deletes expired and denied grants, and a successful redemption consumes the
grant. A CLI session is a row in `session` like a browser sign-in, so a future
device list can show both from one table.

## Approval page (`/cli/authorize`)

`src/routes/cli/authorize.tsx`, components in `src/components/cli-auth/`.

- Opening a verification link only prefills the code; headless devices can type
  it instead. Anonymous visitors go through the existing `/login` with a
  same-origin return path that carries only `user_code`; the page never asks for
  a password.
- An explicit "Review request" calls `GET /api/auth/device?user_code=…`, which
  claims a pending request for the signed-in account. Only that account gets the
  request details back; another account sees "Claimed by another account".
- The review shows the account, the origin, the code to compare and that
  approving grants full access to the account. Approve requires confirming that
  the person started the request and the code matches; Deny does not. Decisions
  are `POST /api/auth/device/approve` or `/deny` with `{"userCode":"…"}`.
- Each call is a single explicit action: never retried, guarded against double
  submission, and sent with `networkMode: 'always'` so an offline decision fails
  at once instead of being sent later. Only a server-confirmed success is shown
  as approved or denied; a network failure says the choice may not have been
  saved and points to the device. Expiry, an already decided request, another
  account's claim, a lost session, rate limiting and an origin mismatch each have
  their own state. A different code in the URL starts a separate review.
- The root route (`src/routes/__root.tsx`) sends `Referrer-Policy:
  strict-origin` with every page response and repeats it as a meta tag, so a URL
  holding the code never appears in a Referer, whether loaded directly or
  reached in-app. `no-referrer` is not used document-wide because it would send
  `Origin: null` on same-origin form posts (and, per the Fetch standard, other
  non-CORS posts), including from srcdoc widgets, which the App data API rejects.
  Search values that JSON would read as a different number (for example the user
  code `23456E78`) keep their original text (`src/search-params.ts`).

## Run tokens

The existing internal HTTP server accepts
`POST /internal/api/runs/:runId/token` with `{"runnerId":"..."}`, authorized
by the fleet `AGENT_RUNNER_TOKEN`. That token proves membership in the trusted
Runner fleet, not a distinct Runner identity. The Runner must be connected and
own the Run, and the Run must be `running`/`blocked` with a live lease.

The response is `{ token, expiresAt, context: { runId, sessionId, runnerId } }`.
Better Auth's JWT plugin in `src/auth/server.ts` owns signing, verification and
encrypted signing-key storage. `src/server/agent-runner/run-auth.ts` owns only
Run binding and lifecycle authorization, independently of the CLI adapter and
the shared fleet `AGENT_RUNNER_TOKEN`. It calls `auth.api.signJWT` and
`auth.api.verifyJWT`; there is no platform-owned signing key or verifier.
Token failures carry transport-neutral error codes; the HTTP adapters preserve
`invalid_token`/`run_ended` as 401 and `runner_not_connected` as 403.
The token uses Better Auth's default asymmetric signing algorithm (EdDSA), with
issuer `APP_URL`, audience `hatch-run` and a five-minute expiry. Signing keys
live in Better Auth's `jwks` table and rotate after 30 days; private keys are
encrypted by Better Auth. JWKS retain rotated public keys for a five-minute
grace period; Run credentials expire within that period. Nothing is stored per
token. Every use verifies the signature and expiry
and then rechecks that the Run is still live and still matches its session and
Runner, so cancelling or finishing the Run ends its tokens immediately. Renewal is
the same call. JWTs do not become Better Auth sessions. Public `/api/auth/token`
and `/api/auth/jwks` are disabled, and session responses do not include JWTs;
the fleet-authenticated internal endpoint is the only HTTP issuance path.

Run and session records currently have no user owner. User/organization API keys
cannot represent them without a separate identity-model change. Keep ordinary
user API keys separate rather than inventing a user ID for a Run.

For a fresh deployment, apply the migrations (`pnpm migrations:apply`) before
starting the platform. The `jwks` migration creates Better Auth's signing-key
table; keys are provisioned by the plugin on first issuance. Keep the database
and `BETTER_AUTH_SECRET` persistent across restarts: stored private keys depend
on the auth secret for decryption. To rotate that secret, follow Better Auth's
secret-rotation procedure. Signing-key rotation is managed by the JWT plugin
separately from secret rotation.

The internal request/response fields and Bearer transport are unchanged.
Platform/Runner protocol stays at 18; the renamed issuance URL has never shipped.
App/Workflow compatibility versions do not change.

Host consumption is an interface only: a trusted Host may later provide the token
to its Agent environment. No environment injection is implemented here.

## Public platform API (`/api/rpc`)

CLI and mobile business operations use the versioned Connect services; the
platform Web UI uses TanStack Server Functions, and user App Connect remains
separate. Better Auth device/login/logout stays on `/api/auth/*`.

Public RPC authentication accepts session Cookie/Bearer, API key and live Run
JWT with explicit-key, Authorization, Cookie precedence. Invalid explicit
credentials never fall back to a valid Cookie. Same-origin restrictions, request
limits and credential redaction remain enforced. Calls use Connect JSON or
binary messages and Buf Protovalidate input rules.

The contract, methods, errors and examples are in [platform-api.md](platform-api.md).
Former REST URLs and `openapi.json` are removed without aliases. No database,
App/Workflow deployment compatibility or Runner protocol migration is required.
