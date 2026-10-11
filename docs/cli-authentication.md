# CLI authentication

How the `hatch` CLI and Agent Runs authenticate to the platform. This change
adds the server side and the browser approval page; it does not implement the
CLI, profile storage, environment injection or changes to Agent Tools/Skills.
Platform/Runner protocol stays at **18**; App and Workflow compatibility
constants and source/deployment/data contracts are unchanged.

## Model

| Credential         | How it is obtained                                 | Lifetime                                     | Authority                     |
| ------------------ | -------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| CLI session        | Device login, approved by a signed-in browser user | Better Auth session (7 days, renewed on use) | Same as a browser session     |
| Run token (JWT)    | Trusted Runner, for a live Agent Run               | 5 minutes, only while the Run is live        | All CLI API routes            |
| Runner fleet token | Deployment operator                                | Existing configuration                       | Trusted internal REST/WS only |

There is no scope or resource configuration yet: a CLI session is a full
Better Auth session, and a Run token can call every CLI API route.

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
   into the session, so the CLI API and every other session-protected endpoint
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
`POST /internal/api/cli/runs/:runId/token` with `{"runnerId":"..."}`, authorized
by the fleet `AGENT_RUNNER_TOKEN`. That token proves membership in the trusted
Runner fleet, not a distinct Runner identity. The Runner must be connected and
own the Run, and the Run must be `running`/`blocked` with a live lease.

The response is `{ token, expiresAt, context: { runId, sessionId, runnerId } }`.
The token is an HS256 JWT (`src/server/cli/run-token.ts`) signed with a key
derived from the platform auth secret, with audience `hatch-run` and a five-minute
expiry. Nothing is stored per token. Every use verifies the signature and expiry
and then rechecks that the Run is still live and still matches its session and
Runner, so cancelling or finishing the Run ends its tokens immediately. Renewal is
the same call. Changing `BETTER_AUTH_SECRET` invalidates outstanding Run tokens.

Host consumption is an interface only: a trusted Host may later provide the token
to its Agent environment. No environment injection is implemented here.

## CLI API (`/api/cli/v1`)

`src/server/cli/api.ts`. Callers authenticate with a session (Cookie or Bearer)
or a Run token; a Bearer value with three dot-separated parts is treated as a Run
token. Responses are JSON with `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. POST bodies must be `application/json` (Git
deployment bundles up to 256 MiB, others 16 KiB), which a cross-site form cannot
send.

| Method and route                                     | Result                                              |
| ---------------------------------------------------- | --------------------------------------------------- |
| `GET /apps`, `/workflows`                            | Minimal inventory                                   |
| `GET /apps/:id`, `/workflows/:id`                    | Minimal metadata including creation/generation time |
| `GET /apps/:id/source`, `/workflows/:id/source`      | Git master commit and source bundle                 |
| `POST /apps`, `/workflows`                           | Existing scaffold result                            |
| `POST /apps/:id/deploy`, `/workflows/:id/deploy`     | Deployment ID, version and compatibility version    |
| `POST /apps/:id/rollback`, `/workflows/:id/rollback` | Existing version restore result                     |

`:id` is matched as an exact immutable ID first and only then as a slug, so a slug
equal to another object's legacy ID cannot redirect a request. Create uses the
existing scaffold input (`slug`, `name`, optional `description`/`pin`). Deploy uses
`message`, `generation` (the observed metadata `createdAt`), `bundleBase64` and the
optional data-migration approval fields. Rollback uses `{"version":1}`. Errors are
`{ "error": code }` with 400, 401, 404, 409, 413 or 415; service failures add a
client-facing `message`; unknown failures return 500 without exception text. Data
queries, KV, secrets, providers, users and Runner controls have no route here.

## Rollout

Apply the additive migration (`pnpm migrations:apply`); it creates Better Auth's
`device_code` table and leaves existing users, accounts and sessions untouched.
There is no feature flag. To sign every CLI out at once, delete the sessions you
want to end; Run tokens end with their Runs or when the auth secret changes.

## Verification

Run `pnpm check:types`, `pnpm format`, `pnpm test:unit` and `pnpm test:browser`,
plus the real-Postgres suite against a disposable database:

```sh
HATCH_AUTH_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project unit \
  src/server/cli/cli.integration.test.ts
```

It drives real Better Auth device login, bearer sessions and sign-out, denial and
another account's claim, the CLI API's authentication and ID-before-slug
resolution, and Run tokens through an actual protocol-18 WebSocket Runner and the
internal HTTP server. Without the variable it is skipped, never reported as
acceptance. Browser acceptance must additionally load the built approval page,
log in, approve and deny real requests, and inspect screenshots and network
outcomes; `src/components/cli-auth/device-approval.browser.test.tsx` covers the
page's decision boundaries with a stubbed `fetch` and does not replace it.
