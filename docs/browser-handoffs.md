# Browser handoffs

`AuthService.CreateHandoff` lets a native client establish browser authentication
using its current Better Auth session. It does not create another session or
choose a resource to open. API keys and Agent Run tokens cannot issue handoffs,
even when a valid session cookie is also supplied.

## Public contract

Call `POST /api/rpc/hatch.platform.v1.AuthService/CreateHandoff` with a session
Bearer token, `Connect-Protocol-Version: 1`, and `Content-Type: application/json`.
The request is empty:

```json
{}
```

There are no App, Dashboard, URL, redirect or resource fields. Unknown JSON
fields fail. A valid session can create and consume a handoff even when there
are no resources, or when resources change between issuance and consumption.

```json
{
  "url": "https://hatch.example/api/auth/handoffs/consume",
  "ticket": "ONE_USE_TICKET",
  "expiresAt": "2026-10-23T10:01:00.000Z",
  "completionUrl": "https://hatch.example/api/auth/handoffs/complete"
}
```

With the generated platform client:

```ts
const handoff = await api.auth.createHandoff({});

// Open the native WebView with a top-level form POST request.
const source = {
  uri: handoff.url,
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ticket: handoff.ticket }).toString(),
};
```

Validate both returned URLs against the connected instance origin and their
fixed paths before opening the WebView. Let the consumer set the HttpOnly cookie
and follow its `303` redirect to `completionUrl`. The fixed completion page
returns `200` only for a live browser Cookie; a Bearer header alone cannot finish
this step. It contains no credentials, resource data, or JavaScript.

After observing the successful completion navigation, replace the POST source
with a GET navigation to the client's desired same-instance page, using the
same WebView and Cookie store. Do not reload or replay the consumed POST. For
example, navigate to `/dashboard/:id` or `/app/:slug/embed/`; subsequent page
changes reuse the same browser session without another handoff. Each page and
its server endpoints remain responsible for resource availability and access.
Future mobile routes need no handoff API change.

Do not attach an Authorization header to the WebView, inject credentials through
JavaScript, HTML or a message bridge, or put the ticket/session token in a URL.
If the WebView is recreated with a fresh non-persistent Cookie store, obtain a
fresh handoff. Navigation callbacks need only the completion URL and outcome;
there is no token-bearing JavaScript bridge.

## Security and session lifecycle

Tickets contain 256 random bits, live for at most 60 seconds (bounded by the
issuing session expiry), and are stored only under a SHA-256 digest in the
existing verification table. Generic storage holds only the original session ID
and exact instance origin, never a resource, redirect path, or session token.
One atomic PostgreSQL `DELETE ... RETURNING` claims a ticket across consumers.

Consumption rechecks the trusted instance origin, exact issuing origin, and live
original session before signing the existing session token into Better Auth's
host-only, HttpOnly, SameSite=Lax cookie with `Path=/`. HTTPS responses also set
Secure. This is ordinary session authority across the instance, not an App- or
Dashboard-specific permission grant.

A supplied Origin header must match the request origin; opaque and cross-site
requests fail. Native requests without browser Origin headers remain supported.
Only a bounded form POST with exactly one ticket field is accepted; GET,
duplicate fields and redirect parameters fail. Responses are not cacheable and
suppress referrers. Claimed tickets stay spent after failed revalidation.

Native sign-out or server revocation ends the shared session for both clients
and prevents pending tickets and completion-page access. An independently
logged-in browser already holding a different session is switched to the issuing
session. Cookie expiry tracks that session; normal Better Auth refresh rules
remain unchanged.

## Published App compatibility

`AppService.CreateAppHandoff` remains callable with the same wire fields and
ID-or-slug resolution (ID takes precedence). It is marked deprecated. Existing
clients still receive `{url, ticket, expiresAt, targetPath}` and a redirect to
`/app/:slug/embed/`, with the original App availability checks at both issuance
and consumption. A rename invalidates an issued legacy ticket. This legacy
adapter is the only path with resource/navigation state; it shares ticket
issuance, expiry, atomic consumption, session/origin validation and Cookie
creation with the generic method.

Legacy calls continue issuing the original `app-handoff:` envelope, which old
and new servers can consume. Unexpired tickets issued before upgrade also work.
The generic API uses a resource-free `handoff:` envelope and fixed completion
route; deploy those consumers on every serving instance before enabling generic
clients during a rolling rollout. On rollback, clients must use the existing
legacy App RPC or wait for the generic endpoint to return. Expired handoff records
are pruned without touching other verification records.

No new Dashboard RPC, mobile layout, database migration, App/Workflow
compatibility bump, Platform/Runner protocol change, or historical data migration
is required. Resource access retains the existing single-tenant authority model.

## Verification

Durable tests exercise real Better Auth with the migrated in-memory PostgreSQL
schema: empty JSON and binary requests, resource independence, completion Cookie
verification, original session identity, credentials, revocation, expiry,
concurrent claims, origin/redirect boundaries and published App compatibility.
Product acceptance runs a dedicated PostgreSQL-backed platform, completes the
handoff in a clean browser, then visits real App and Dashboard pages with the
same Cookie.
