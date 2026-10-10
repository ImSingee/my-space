# Device approval UI replacement

The user rejected the first authorization page's visual design and requested
that it be deleted and replaced by the Lody P6 role. The original
`src/routes/cli/authorize.tsx` has been removed. Backend authentication remains
in this working tree. Implement the replacement, rather than restoring the
old card layout. Keep issuance disabled until the replacement is verified.

## Scope and design

Build only the browser device authorization journey at `/cli/authorize`.
Use Hatch's existing visual language, typography, branding, spacing and
Mantine components. Make the code and decision clear, with a compact,
well-organized consent view that works on desktop and mobile, light and dark
themes, and with keyboard navigation. Explain permissions in ordinary language
instead of presenting a long technical dump. Preserve access to exact scope
and resource details for informed consent. Choose the layout independently.

Do not redesign the rest of Hatch, implement a CLI client, add a key-management
dashboard, change credential persistence, or change authorization policy,
database schema, Runner protocol, App/Workflow compatibility or Agent Tools/Skills.
Reuse the existing login page and server contracts. Code and documentation
must be English; user-facing review explanations may be Chinese.

## Required journey

1. Accept `?user_code=...` and manual code entry for a headless device. A URL
   may prefill the code; navigation must never claim or approve it automatically.
2. When anonymous, redirect to existing `/login`, retaining only a safe
   same-origin return path and the user code. After login, return to review.
   The browser uses its real Cookie session; do not solicit a password here.
3. An explicit review action claims the request. Display the confirmed code,
   approving account, instance/origin, permissions, resource range, credential
   lifetime and request expiration. Clearly warn against approving a request
   the person did not initiate. An all-resource grant includes future resources.
4. Require deliberate code confirmation before enabling Approve. Deny is
   available independently of confirmation. Use distinct action emphasis,
   prevent repeated submissions, and disable competing decisions while pending.
5. Show clear approved/denied outcomes and instruct the person to return to
   their requesting device. Browser approval itself never receives or stores
   the issued key; the device redeems it through the server polling endpoint.
6. Handle loading, invalid/missing code, expiration, issuance disabled,
   authentication loss, request already processed, cancellation, another
   account/session's claim, network failure and decision conflict. Do not show
   an approval that the server did not confirm. Never retry a decision implicitly.
   Refresh/back navigation must not silently perform another decision; an
   already-processed response can explain that the requesting device has the
   authoritative outcome when the existing API cannot distinguish its state.

## Existing interfaces

All three calls are JSON POSTs with `{ "user_code": "..." }`, same-origin
real Cookie credentials, and `Content-Type: application/json`:

- `/api/cli/v1/auth/device/claim`: returns `userCode`, `account`, `instanceId`,
  `scopes`, `resources`, `credentialType`, `expiresIn` (key lifetime in seconds),
  and `grantExpiresAt`. This is a mutation, not a fetch to run automatically.
- `/api/cli/v1/auth/device/approve`: returns `{ "status": "approved" }`.
- `/api/cli/v1/auth/device/deny`: returns `{ "status": "denied" }`.

Non-success JSON responses contain an `error` code. Inspect the current server
implementation for exact behavior: `src/server/cli-auth/device.ts`, `http.ts`,
`credentials.ts`, `src/auth/cli-policy.ts`, and
`docs/server-credential-authorization.md`. Existing login uses
`src/routes/login.tsx`; SPA route guards run in the browser. Use TanStack Query
mutations for claim/decision and the existing authentication APIs for login.
Do not put Cookie contents, device redemption secrets or issued keys in URLs,
storage, analytics or logs. Preserve the `no-referrer` policy.

## Completion and verification

Generate the route tree through normal tooling; never edit generated files.
Run `pnpm check:types` and `pnpm format`. Verify the real built page against
isolated Better Auth and PostgreSQL: anonymous login and return, signed-in
review, explicit code confirmation, approve, deny, invalid/expired/conflicting
requests and non-success network responses. Inspect screenshots at desktop
and mobile sizes and in both themes. Durable tests should cover behavior and
security boundaries, not exact prose or DOM structure. Update the server
document's temporary replacement note after the new page is verified. Do not
commit or create a PR in this delegated task.
