# Server credential authorization

This is a server capability. It does not implement a CLI, credential configuration,
profile storage, environment injection, launcher, or changes to Agent Tools/Skills.
Platform/Runner protocol stays at **18**; App and Workflow compatibility constants
and source/deployment/data contracts are unchanged.

## Enablement and rollout

1. Install the locked dependencies with `pnpm install --frozen-lockfile`. Better
   Auth, its Drizzle adapter and `@better-auth/api-key` are pinned to 1.7.2. Zod is
   aligned to the platform's 4.5.2 because grant schema types cross package boundaries.
2. Back up PostgreSQL. Apply additive migrations with `pnpm migrations:apply`.
   The migration journal makes retries safe. Do not replay the raw SQL outside the
   journal. The migrations preserve existing user/account/session/verification
   records and Cookie sessions. No historical Agent Run receives a guessed issuer.
3. Deploy the server with issuance initially disabled (the default). Set
   `HATCH_CLI_AUTH_ENABLED=true` only when migrations and acceptance succeed.
   `APP_URL` remains the canonical public origin. Use HTTPS in production; the
   existing internal server must remain inside the trusted deployment network.
4. Validate the Cookie login, approval page, key management and a connected
   protocol-18 Runner before enabling callers. Revocation remains available when
   issuance is disabled. Cookie permissions remain the existing single-tenant
   administrator permissions; this feature does not introduce multi-tenancy.

To stop issuance, unset `HATCH_CLI_AUTH_ENABLED` and restart. Existing credentials
continue to be checked and can be revoked. To invalidate all previously issued
credentials and grants (for emergency rollback, restoration or compromise),
increment `cli_auth_instance.epoch` in a controlled database transaction. Keep the
new resolver/revocation endpoints until credentials have been retired. Rolling
back to older server code preserves Cookie login, but that code has no new public
credential API. Keep all new tables, migration journal entries, triggers and audit;
do not drop them on application rollback. Apply the same migrations on the next
upgrade. Do not attempt to undo already committed App data migrations.

Each fresh installation gets a persistent random `instance_id`. Moving the same
installation retains it. When restoring a backup, advance its epoch before
serving traffic. A separate installation made by cloning data must obtain a new
instance identity and advance its epoch; restoring the old identity/epoch would
also restore old credential authority. Database administrators remain trusted.

Generated auth schema is owned by `pnpm auth:generate`; never edit
`src/db/auth-schema.ts` manually. Hatch context tables are owned by
`src/db/cli-auth-schema.ts`. Generate schema migrations with
`pnpm migrations:generate`, review the SQL and add explicit SQL for lifecycle
triggers. Relational queries use Drizzle RQB v2 object filters.

## Credential boundaries

| Credential         | Issuer                                               | Default / maximum lifetime     | Authority                                                              |
| ------------------ | ---------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `interactive_key`  | Real Cookie user explicitly approving a device grant | 7 days / 30 days               | Approved scopes and resources                                          |
| `user_api_key`     | Real Cookie user naming a key                        | Required, 5 minutes to 90 days | Explicit scopes and resources                                          |
| `run_key`          | Trusted Host/Runner internal endpoint                | 5 minutes                      | Server-owned Run grant plus current Run/session/runner/lease           |
| Runner fleet token | Deployment operator                                  | Existing configuration         | Trusted internal REST/WS; never a public lifecycle or Agent credential |

Cookie session, API key record and credential binding are different objects.
A Bearer string is verified by the API-key plugin and then by Hatch's binding,
user/security epoch, installation epoch and (for Run keys) live Run checks. It is
never converted into a full Better Auth session. The plugin has
`enableSessionForAPIKeys=false`, hashing enabled, database storage, synchronous
updates and empty default permissions. Plugin-generated opaque keys have no
local type/scope authority; returned `credentialType` is server-resolved.

Opaque keys are preferred over JWTs because this API already needs authoritative
revocation and live lease checks on each request. JWT signatures alone would not
satisfy cancellation. No OAuth provider, Bearer plugin, JWT issuer/JWKS, client
secret or Broker is introduced.

## Scope and resource contracts

The only scopes are:

- `app.read`, `app.source.read`, `app.create`, `app.deploy`, `app.rollback`
- `workflow.read`, `workflow.source.read`, `workflow.create`, `workflow.deploy`,
  `workflow.rollback`

Source checkout refresh requires `*.source.read`; there is no Platform `update`
write scope. Scope does not imply other scopes. A create-only key can create but
cannot inspect or deploy the resulting object unless explicitly granted those
scopes. Data queries, KV, Data Table SQL, secrets, providers, Users, other Agent
sessions and Runner controls have no route in this public API.

Resource ranges are either `{"mode":"all"}` (explicitly includes future
resources), or `{"mode":"ids","apps":["immutable-id"],"workflows":[]}`. Omitted
range defaults to an empty ID set, never unrestricted access. Finite grants cannot
include create. Existing IDs are validated before issuance. Slugs resolve to an
immutable ID before permission checks; list results are filtered to authorized
IDs. A mention is not a capability. Only the current platform administrator model
supplies issuer rights; there is no assumed per-user ownership ACL.

Lifecycle writes enter a server-owned operation context, never accept principal
fields from the body, and re-check the binding/epochs/Run in the service's cutover
transaction after waiting for deployment locks. Provisioning/migration entry also
checks authorization. Long builds can finish preparing artifacts after a key
expires, but cannot activate a release after the cutover check fails. Existing
Cookie and internal service calls retain their existing behavior. Already-started
irreversible external work or committed writes are not undone by later revocation.

## Public HTTP API

All routes below are under `/api/cli/v1`. Responses use JSON, `Cache-Control:
no-store` and `Referrer-Policy: no-referrer`. They do not redirect with credentials.
There is no token/password-in-URL endpoint. Key requests use `Authorization:
Bearer <opaque key>`; Cookie management rejects Bearer and `x-api-key` inputs.
Cookie mutations require an exact canonical `Origin` and reject cross-site fetches.
Bodies are strict JSON. Auth bodies are capped at 16 KiB; Git deployment bundles
use the existing 256 MiB cap. Do not log authorization headers, request bodies or
successful issuance responses at a proxy or tracing layer.

| Method and route                                     | Authorization                    | Result                                                                                     |
| ---------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /instance`                                      | Public                           | Persistent instance ID and canonical URL                                                   |
| `POST /auth/device`                                  | Public, fixed `hatch-cli` client | Verification URLs, user/device codes, 600-second grant lifetime, 5-second initial interval |
| `POST /auth/device/token`                            | Possession of device code        | Poll error or one `interactive_key`                                                        |
| `POST /auth/device/cancel`                           | Possession of device code        | Cancel pending/approved grant                                                              |
| `POST /auth/device/claim`                            | Real Cookie                      | Bind pending grant to exact user and Cookie session; return review details                 |
| `POST /auth/device/approve` or `/deny`               | Same claimed Cookie              | One terminal decision                                                                      |
| `GET /auth/status`                                   | Opaque key                       | Principal, credential type, scopes, resources and server-owned context; no secret          |
| `POST /auth/revoke-self`                             | User or interactive key          | Revoke that credential; Run keys rejected                                                  |
| `GET /auth/keys`                                     | Real Cookie                      | Own credentials, names, lifetime and status; no token/hash                                 |
| `POST /auth/keys`                                    | Real same-origin Cookie          | Create named, expiring `user_api_key`; secret returned once                                |
| `POST /auth/keys/:id/rotate`                         | Real same-origin Cookie          | Same scope/resources, new expiration, new secret once; disable old key atomically          |
| `POST /auth/keys/:id/revoke`                         | Real same-origin Cookie          | Idempotent own-key revocation; Run keys rejected                                           |
| `GET /apps`, `/workflows`                            | `*.read`                         | Filtered minimal inventory                                                                 |
| `GET /apps/:id`, `/workflows/:id`                    | `*.read` and resource            | Minimal metadata including creation/generation time                                        |
| `GET /apps/:id/source`, `/workflows/:id/source`      | `*.source.read` and resource     | Git master commit and source bundle                                                        |
| `POST /apps`, `/workflows`                           | `*.create`, all resources        | Existing scaffold result                                                                   |
| `POST /apps/:id/deploy`, `/workflows/:id/deploy`     | `*.deploy` and resource          | Existing Git-bundle deployment result, stripped to release identifiers/version             |
| `POST /apps/:id/rollback`, `/workflows/:id/rollback` | `*.rollback` and resource        | Existing version restore result                                                            |

A user key creation body is, for example:

```json
{
  "name": "CI release",
  "expiresIn": 3600,
  "scopes": ["app.read", "app.source.read", "app.deploy"],
  "resources": { "mode": "ids", "apps": ["immutable-app-id"], "workflows": [] }
}
```

A device request body replaces `name` with `"client_id":"hatch-cli"`;
`expiresIn` is optional there and means the final key lifetime, not the grant
lifetime. Token/cancel bodies contain `client_id` and `device_code`. Browser
claim/approve/deny bodies contain `user_code`. Rotation requires only `expiresIn`;
it cannot broaden scope or resources. Revoke needs no body fields. Create uses
existing scaffold input (`slug`, `name`, optional `description`/`pin`) and rejects
caller-supplied session/principal identity. Deploy uses existing `message`,
`generation` (the observed metadata `createdAt`), `bundleBase64` and optional
explicit data-migration approval fields. Rollback uses `{"version":1}`.

Every issuance response contains `id`, `token`, `credentialType`, `instanceId`,
`scopes`, `resources`, and `expiresAt`. Only that response includes the raw token.
A lost response is not recoverable by listing. Revoke the credential if known and
start a new grant/create operation. Responses/errors are not authorization caches.

Errors use stable `error` codes with HTTP 400 (invalid request/grant/poll state),
401 (missing/expired/revoked credential or ended Run), 403 (scope/resource/approval
or Origin denial), 404 (missing/excluded route/resource), 409 (decision/rotation/
generation conflict), 413/415 (body size/type), 429 (budget exhausted), 503
(issuance disabled), or 500 (unknown internal failure without exception text).
Anonymous issuance has a shared database budget; authenticated management and
code claims have per-account budgets. Deployments should also use a trusted
edge's per-peer rate limits; forwarded IP headers alone are not identity.

## Device approval and concurrency

The browser approval page is `/cli/authorize` (`src/routes/cli/authorize.tsx`,
components in `src/components/cli-auth/`). It replaces the first, removed design;
requirements are in `docs/device-approval-ui-requirements.md`. Browser acceptance
recorded before the replacement describes the removed page, not this one.

Opening a verification link only prefills the code; headless devices can type it
instead. Anonymous visitors go through the existing `/login` with a same-origin
return path that carries only `user_code`; the page never asks for a password.
An explicit "Review request" claims the grant for the current Cookie session.
The review keeps to what the decision needs: code, account, instance origin,
request expiry and one plain-language sentence covering access, resource range
(an all-resource grant states that it includes future apps and workflows) and
key lifetime. Per-object capabilities, named resources, exclusions, exact scopes
and the instance ID are under "Details". Approve requires confirming that the
person started the request and the code matches; Deny does not.

Each claim or decision is one same-origin JSON POST containing only `user_code`,
sent with `no-referrer`, never retried automatically and guarded against double
submission. Only a server-confirmed `approved`/`denied` status is shown as an
outcome. A network failure or unreadable response says the choice may not have
been saved and points to the device; "Check again" re-claims, which reports a
decided, cancelled or consumed grant as closed. Expiry, another session's claim,
session loss, security-epoch change, deleted resources, rate limiting, issuance
being disabled and origin mismatch each have their own state. The browser never
receives the device code or the issued key and stores nothing. Its claim and
decision requests use `referrerPolicy: 'no-referrer'`. Because one SPA document
serves every route, the root route (`src/routes/__root.tsx`) sends a
`Referrer-Policy: strict-origin` header with every shell response, whatever path
or casing loaded it, and repeats it as a meta tag. Server routes (APIs, App
runtime) return their own responses and keep their own policies; the CLI API
still sends `no-referrer`. Referer carries only the origin, so a URL holding the
code (`/cli/authorize?user_code=…`, or `/login` returning to it) never appears in
Referer headers, whether loaded directly or reached in-app.
`no-referrer` is not used document-wide because it would send `Origin: null` on
same-origin form posts (and, per the Fetch standard, other non-CORS posts),
including from srcdoc widgets that inherit the policy; the App data API rejects
a Cookie request whose Origin does not match. A different code in the URL starts a separate review. Mutations use
`networkMode: 'always'`, so an offline decision fails at once instead of being
sent later on reconnect. Search values that JSON would read as a different
number (for example the user code `23456E78`) keep their original text
(`src/search-params.ts`).

Issuance remains disabled by default. Enable `HATCH_CLI_AUTH_ENABLED` only after
migrations and deployment acceptance. No password grant or silent fallback exists.

Code generation, unique indexes and grant schema extensions use Better Auth
1.7.2. Its standalone `/device` and `/api-key` HTTP endpoints are sealed both at
the route and at the auth hook; session-token exchange is additionally rejected
by the grant's `assertSessionRedemption`. Anonymous `user_id` is rejected.

Hatch serializes claim/approve/deny/cancel/poll/consume using a PostgreSQL row
lock on the plugin's device-code table. A different user or a different Cookie
session of the same user cannot take over a claim. Approval's Cookie session must
still exist at exchange. Expiration and user/installation epochs are rechecked.
Only one approve/deny transition succeeds. Cancellation and exchange are ordered:
cancellation winning prevents issuance; exchange winning consumes the grant and
later cancellation gets a conflict (revoke the resulting user credential instead).

Polling returns `authorization_pending`, `slow_down`, `access_denied`,
`expired_token` or `invalid_grant`. Too-early polls persist a five-second increase
in that grant's interval. **Plugin storage uses milliseconds; HTTP uses seconds.**
Grant consumption and audit commit together before key issuance. Consumed grants
remain tombstones, so concurrent or repeated exchanges cannot issue another key.
A failed issuance or lost response does not reopen the grant. Database maintenance
may delete expired/consumed device records after the audit retention policy permits;
never restore a consumed grant to pending.

## Run mint/renew interface

The existing internal HTTP server accepts optional endpoints:

- `POST /internal/api/cli/runs/:runId/credential` with `{"runnerId":"..."}`
- `POST /internal/api/cli/runs/:runId/credential/renew` with `runnerId` and
  `credentialId` of a previous key for that same Run/Runner

Both require the existing fleet `AGENT_RUNNER_TOKEN`. This token authenticates
membership in a trusted Runner collection; it does **not** independently prove
a distinct Runner identity. Within that trust boundary, the requested runner must
be currently registered and ready and equal the actual database Run owner. The
Run grant must match session/user/installation, remain unrevoked, and have a live
lease and active `running`/`blocked` status. A public user key or Agent Run key
cannot mint/renew through these endpoints. Future per-Runner authentication is a
separate hardening task, not a required handshake here.

A real Cookie-initiated Run records an immutable lifecycle grant in the same
transaction as Run creation. Current single-tenant administrators authorize all
lifecycle scopes/resources for their runs, excluding all other capabilities.
Historical Runs and direct legacy service starts without a Cookie issuer cannot
mint credentials. New Runs have fresh grants; reusing a session does not reuse
old keys. A future recovery action must use the new Run's current grant and
operation/resource validation; old Run authority never transfers implicitly.

Every use checks current user existence/security epoch, instance epoch,
Run/session/Runner binding, grant epoch, active status and lease. Database
triggers permanently invalidate the grant on terminal/cancel/delete, reassignment,
or extending a lease that has already expired. Thus a late heartbeat cannot
revive credentials even if existing runtime reconciliation extends the Run's
lease. User password changes/reset writes and credential-account deletion advance
the security epoch; user deletion advances it too. Cookie logout alone does not
revoke independent user keys. There is no positive authorization cache.

Renewal issues a replacement five-minute key only while the original grant is
live; an expired previous key may identify the grant for a trusted Host renewal.
Prior keys overlap only until their original expiration. Immediate cancellation
still denies all of them. A terminal or expired-then-renewed lease cannot renew.

Host consumption is an interface only in this change: a trusted Host may later
provide the returned Run token to its Agent environment and renew it before
expiry. No environment injection/persistence/launcher is implemented here. Agent
processes receive neither long-term user keys nor the Runner fleet token.

## Database, failure handling and audit

Better Auth owns `apikey` (hash, expiration, permissions and usage) and
`device_code` (code/grant state plus Hatch extension fields). Hatch owns installation
and user epochs, credential context/display snapshots, Run grants, shared rate
budgets and append-only audit. No second secret/hash system or duplicate authority
permissions table is introduced. Display expiration is a historical issuance
snapshot; validity always uses the current plugin key record.

Plugin key creation runs on Better Auth's connection. Activation runs in a separate
transaction that revalidates epochs/resources/Run and writes binding + audit.
An unbound plugin key has no public Hatch authority. Activation failure attempts
to disable the orphan; the missing binding is the fail-closed boundary even if
cleanup fails. Rotation activates the new binding and disables the old binding/key
in one transaction. Competing rotations have one winner. Secret recovery is never
provided. Cleanup of plugin records does not remove Hatch revocation/audit evidence.

Audit records contain IDs, credential type, consent scopes/resource range,
lifetime and reason, never tokens, hashes, device codes, Cookie contents or
passwords. Database triggers reject audit UPDATE/DELETE. User/Run/plugin cleanup
does not cascade audit away; snapshots deliberately have no destructive foreign
keys. Application database credentials must not be reused as untrusted Agent
credentials. SQL administrators can change schema/data and are outside this
boundary.

## Verification

Run normal project quality checks (`pnpm check:types`, `pnpm format`,
`pnpm test:unit`) and the explicit real-Postgres contract suite:

```sh
HATCH_AUTH_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/cli-auth/credentials.integration.test.ts
```

Use a disposable database, never a production database: the suite applies real
migrations, signs up test users, writes lifecycle/Run fixtures, changes passwords,
advances installation epochs and attempts forbidden audit mutation. Without the
explicit test database variable it is skipped, never reported as real acceptance.

The suite uses actual Better Auth and Drizzle PostgreSQL calls and an actual
protocol-18 WebSocket Runner plus the internal HTTP server. Browser acceptance
must additionally load the built approval page, perform existing Cookie login,
confirm/approve and deny real grants, and inspect screenshots/network outcomes.
`src/components/cli-auth/device-approval.browser.test.tsx` (`pnpm test:browser`)
covers the page's decision boundaries with a stubbed `fetch`; it does not replace
that real-server acceptance.
Exercise source/read and real lifecycle creation, default exclusions, scope and
resource denial without mutation, slow-down/expiry and exchange/decision races,
key rotation/revocation/expiry, password/user deletion, unbound activation failure,
Run isolation/terminal/cancel/lease lapse and late renewal, cross-instance denial,
issuance-off rollback and retained audit. Inspect raw artifacts for secret leakage;
passing legacy tests alone is not acceptance of this feature.
