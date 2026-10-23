# Mobile workspace integration

Use the public Connect endpoint at `/api/rpc` with a Better Auth session Bearer
credential. `WorkspaceService.GetWorkspace({})` also accepts a same-origin browser
session cookie. API keys and Run credentials cannot read this interactive view;
explicit invalid credentials never fall back to a cookie.

The response contains:

- `dashboards`: all Dashboard summaries, including unpinned entries, ordered by
  `sortOrder` then `createdAt`, both ascending. Each has `id`, `name`,
  `description`, `pinned`, and `autoRefreshSeconds` (zero disables refresh).
- `appPins`: ordered by `sortOrder` then `createdAt`, both ascending. Preserve the
  array and key entries by pin `id`, not `appId`: the same App may have several
  labels and destinations. Each entry carries `appId`, `appSlug`, `label`, and
  `entryHash`. The hash has no leading `#`; an empty value opens the App root.
  Use the slug for `/app/:appSlug` and retain the entry hash when navigating.
- `pinnedWorkflowIds`: non-archived pinned Workflows, ordered by `updatedAt`
  descending, matching the current web sidebar.

Archived Apps and Workflows are excluded. Dashboard and App-pin projections share
read functions with the web UI. On an empty instance, both web and native reuse
the existing idempotent `default` / `My Dashboard` initialization. Rejected
requests do not initialize it. This is a single-tenant shared workspace, not
per-user resource ownership.

## Browser session and dashboard canvas

The merged authentication contract is resource-independent:

1. Call `AuthService.CreateHandoff({})` with the existing user session.
2. In a fresh browser/WebView, POST a form containing only `ticket` to the
   response `url`. Never put the ticket or session token in a URL.
3. Wait for the response's exact `completionUrl` to load successfully. This
   establishes the original session as an HttpOnly cookie.
4. Navigate within that same browser to `/mobile/dashboard/:dashboardId`, using
   an encoded ID from `GetWorkspace`. Ordinary web navigation continues to use
   `/dashboard/:dashboardId`.

The mobile route is outside the web navigation shell. It uses the existing
Dashboard widget runtime, disables layout editing, supports manual and configured
automatic widget refresh, and includes loading, retry and empty states. The route
checks the session and the underlying server functions independently enforce
session authentication. Missing Dashboard IDs show a retryable error.

Do not call `WorkspaceService.CreateDashboardHandoff`; this service has no such
method. Mobile clients from the earlier branch must replace that call with the
four-step generic handoff sequence above. No new handoff target or arbitrary URL
parameter is introduced. Session revocation, ticket replay and origin checks
remain owned by the shared AuthService implementation.
