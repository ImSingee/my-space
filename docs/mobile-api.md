# Mobile API v1

All `/api/mobile/v1` endpoints require a Better Auth session Bearer token, except
`POST /handoffs/consume`. API keys, Runner JWTs, and Workflow secrets do not grant
interactive session access. Responses use `Cache-Control: no-store`; mobile does
not add CORS or weaken the browser origin/CSRF boundary. Hatch remains
single-tenant: authenticated users retain the platform's existing full authority.

## Device authorization

Use the existing Better Auth device flow with `client_id: "hatch-mobile"`:

1. `POST /api/auth/device/code` with the client ID.
2. Display the user code and open the returned, same-origin `/cli/authorize` URL
   in the system browser. The approval screen identifies **Hatch Mobile**.
3. Poll `POST /api/auth/device/token` using the device code and
   `grant_type: "urn:ietf:params:oauth:grant-type:device_code"` at the supplied
   interval. Respect pending, slow-down, denial, cancellation, and expiration.
4. Store the resulting session token securely under the exact instance origin.

No real account, token, provider secret, or login was used in implementation tests.

## Native resources

- `GET /apps` → `{ apps: AppSummary[] }`. Summary fields: `id`, `slug`, `name`,
  `description`, `status`, `capabilities`, `createdAt`, `updatedAt`.
- `GET /apps/:id` → `{ app }`, adding `deploymentRevision` (deployment ID or null)
  and `compatibility` (existing platform compatibility view or null).
- `GET /sessions?appId=...` → `{ sessions: SessionSummary[] }`.
- `POST /sessions` with optional `title`, `providerId`, `modelId` → `201 { id }`.
- `GET /sessions/:id` → `{ session }`: existing stable session detail fields,
  including `messages`, `activeRun`, `runs`, `updatedAt`, and `serverTime`.
- `GET /config` → `{ apiVersion: 1, providers, defaultModel }`. Providers contain
  only enabled model metadata and labels; no keys or provider base URLs. The
  default is the first enabled model in the platform's configured sort order.

Ordinary mobile JSON bodies are capped at 16 KiB. Invalid/missing resources return
400/404; authentication and origin failures return 401/403. Unexpected server
errors return generic 500 responses, without stack traces or internal details.

## WebView handoff

`POST /handoffs` with `{ appId }` returns `{ url, ticket, expiresAt, targetPath }`.
The App must have a supported, current frontend deployment and not be archived.

The native client validates the response against its own origin, then creates an
incognito WebView with a form POST to `url` containing only `ticket=<ticket>`.
`POST /handoffs/consume` accepts a single form field (maximum body 1 KiB), consumes
the hashed ticket atomically, rechecks the original session/App/origin, sets a
signed HttpOnly cookie, and returns 303 to the server-computed embed path.

Tickets expire in at most 60 seconds and are single-use even across concurrent
consumers. The existing verification table stores only a SHA-256 ticket identifier
and bounded binding metadata, with expired mobile records pruned on issuance.
The cookie references the original native session; no independent long-lived
WebView session is created. Revoking/signing out the native session invalidates
both pending handoffs and existing WebView authentication.

## Agent operations

The mobile app reuses the existing public session-authenticated endpoints:

- `POST /api/agent/runs`: session/model IDs, composer text, optional images and
  attachment IDs; or the existing revision-guarded retry payload.
- `GET /api/agent/runs/:runId/events?after=N`: existing `{ seq, event }` SSE packets.
- `POST /api/agent/runs/:runId/answer`: `{ askId, answers }`.
- `POST /api/agent/runs/:runId/cancel`.
- `PUT /api/agent/sessions/:sessionId/attachments/:attachmentId`: raw file body,
  `Content-Type`, and percent-encoded `X-Attachment-Name`.

The 25 MiB binary limit, per-attachment idempotency, combined six-attachment limit,
25,000,000-byte run body limit, and persistent SSE replay contract are unchanged.
The shared session authentication helper explicitly rejects invalid Bearer
credentials rather than falling back to cookies. Explicit API keys and cross-site
browser requests are rejected. Existing valid same-origin browser sessions work.

## Rollout and recovery

Deploy the backend first, then install the development client. Older backends
return 404 for mobile resource endpoints; clients must not infer authentication
from an API key or fall back to undocumented browser server-function encodings.
The client checks `apiVersion` after login. Rolling back the backend leaves the
existing browser/CLI contracts unchanged but disables mobile v1. Users can revoke
mobile sessions through normal account sessions. No historical App, Workflow,
source package, deployment, or application-data migration is required.
