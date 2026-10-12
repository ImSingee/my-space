# Account sessions

Account lists the authenticated user's active Better Auth browser and CLI
sessions, including sign-in time, user agent and IP address when available.
Each sign-in creates a separate session; the same device can appear multiple
times. The current session is marked and cannot be revoked through Account.
Expired and ended sessions do not appear. No historical login table, trigger,
backfill or additional database migration is required.

Select one other session and confirm to sign it out. There is no bulk action.
The server uses Better Auth's listSessions and revokeSession APIs, resolves the
selected ID only from the authenticated user's sessions, and keeps session
tokens on the server. Missing, expired or already revoked IDs are idempotent;
foreign IDs do not reveal ownership. Successful revocation refreshes the list;
failed requests preserve the list and permit retry. Password changes refresh
this list because Better Auth rotates the current session and revokes others.

The list represents currently active sessions, not a durable login audit log.
Signing out or revoking a session removes it from the list. Cookie caching and
secondary session storage are not enabled. A revoked browser cookie or CLI
bearer token fails on the next authenticated request; already loaded pages may
remain visible until they make another request.

The sidebar's Sign out action ends the current session and replaces the page
with /login, discarding cached private page data. Account's controls revoke only
the selected other session.
