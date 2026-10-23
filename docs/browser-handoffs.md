# Browser handoffs

`AuthService.CreateHandoff` lets a native client open an existing App or
Dashboard using its current Better Auth session. It does not create a second
session. API keys and Agent Run tokens cannot issue handoffs, even when a valid
session cookie is also supplied.

## Public contract

Call `POST /api/rpc/hatch.platform.v1.AuthService/CreateHandoff` with a session
Bearer token, `Connect-Protocol-Version: 1`, and `Content-Type: application/json`.
Choose exactly one resource:

```json
{ "app": { "id": "APP_ID" } }
```

```json
{ "dashboard": { "id": "DASHBOARD_ID" } }
```

Both use immutable resource IDs. The server does not accept a URL, redirect
path, or App slug in the new API. The protobuf `target` oneof is required and
its resource IDs are validated with Protovalidate. Unknown JSON fields fail.

The response preserves the existing handoff transport shape:

```json
{
  "url": "https://hatch.example/api/auth/handoffs/consume",
  "ticket": "ONE_USE_TICKET",
  "expiresAt": "2026-10-23T10:01:00.000Z",
  "targetPath": "/dashboard/DASHBOARD_ID"
}
```

With the generated TypeScript client:

```ts
const handoff = await authClient.createHandoff({
  target: { case: 'dashboard', value: { id: dashboardId } },
});

// Open the native WebView with a top-level form POST request:
const source = {
  uri: handoff.url,
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ticket: handoff.ticket }).toString(),
};
```

The client should validate the response URL against its connected instance
origin before opening the WebView. Do not add an Authorization header to the
WebView or inject tokens through JavaScript, HTML, a message bridge, or a URL.
Let the consume response set the HttpOnly cookie and follow its `303` redirect.
`targetPath` is informational and is not a parameter to consumption.

## Targets and security

App targets resolve to `/app/:slug/embed/`. Both issuance and consumption check
the exact App, current deployment ownership, frontend capability, archive
state, compatibility version, and safe slug. A rename invalidates an issued
ticket because its destination no longer matches. Building an update can keep
the existing deployment available, as with the App runtime.

Dashboard targets resolve to the existing `/dashboard/:id` route. Both phases
check that the Dashboard exists. This is the ordinary authenticated platform
page, including platform navigation. This change does not add a mobile layout.
The future mobile client can use this API immediately; a dedicated mobile
Dashboard route can later be selected by the server's target resolver once
that route exists. Callers must follow the returned POST/redirect contract
rather than construct a destination or add another Dashboard RPC.

Tickets contain 256 random bits, live for at most 60 seconds (bounded by the
issuing session expiry), and are stored only under a SHA-256 digest in the
existing verification table. Storage holds an exact typed target, session ID,
instance origin, and server-selected path, never the session token. One atomic
PostgreSQL `DELETE ... RETURNING` claims a ticket across concurrent consumers.

Consumption rechecks the trusted instance origin, exact issuing origin, live
original session, and current domain availability before signing the existing
session token into Better Auth's host-only, HttpOnly, SameSite=Lax cookie.
HTTPS responses also set Secure. A supplied Origin header must match the
request origin; opaque and cross-site requests fail. Native requests without
browser Origin headers remain supported. Only a bounded form POST with exactly
one ticket field is accepted; GET, duplicate fields, and redirect parameters
fail. Responses are not cacheable and suppress referrers. Claimed tickets stay
spent after failed session/resource/origin revalidation.

Native sign-out or server revocation ends the shared session for both clients
and prevents pending tickets from being consumed. An independently logged-in
browser already holding a different session is switched to the issuing session.

## Compatibility and rollout

`AppService.CreateAppHandoff` remains callable with the same wire fields and
ID-or-slug resolution (ID takes precedence). It is marked deprecated to guide
new clients to `AuthService.CreateHandoff`; its handler only resolves the App
identity and delegates to the same implementation. Existing callers need no
immediate release. There is no new `CreateDashboardHandoff` RPC.

The shared consumer also reads the old `app-handoff:` storage envelope so
unexpired tickets issued before upgrade still work. Newly issued tickets use
the `handoff:` namespace and typed envelope. Deploy the updated consumer on all
serving instances before routing new issuance during a rolling rollout, or
drain traffic while updating; old servers cannot consume the new envelope.
After rollback, clients may need to request a fresh ticket through the old RPC.
Expired handoff records are pruned without touching other verification records.

No database migration, App/Workflow compatibility bump, Platform/Runner protocol
change, or historical App/Workflow data migration is required. Resource access
retains the platform's existing single-tenant authority model.

## Verification

Durable tests exercise real Better Auth with the migrated in-memory PostgreSQL
schema: JSON and binary clients, both targets, the legacy RPC and pending legacy
tickets, shared Cookie identity, credentials, revocation, expiry, concurrent
claims, origin/redirect boundaries, and resources invalidated between phases.
Product acceptance additionally runs a dedicated PostgreSQL-backed platform and
opens the real targets in a clean browser using only the returned Cookie.
