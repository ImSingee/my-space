# App webhook invocation

Hatch invokes authored App HTTP handlers through the existing public runtime URL
`/api/app/<canonical-id>/hook[/suffix]`, forwarded to `/__webhook[/suffix]`.
Management lookup remains Connect RPC at `/api/rpc`; there is no webhook invocation
RPC or alternate REST endpoint. Backend invocation remains `hatch app invoke backend` using Connect unary JSON; webhook invocation sends raw HTTP bytes.

## Authentication and header migration

Both webhook modes now strip Authorization and x-api-key (case-insensitive),
Cookie, x-hatch-* signing/secret headers, routing headers and hop-by-hop headers.
The shared App proxy enforces this policy. Removed values are never copied to an
alternate header. This deliberately replaces Authorization passthrough and removes
x-api-key passthrough, including on `auth: none` deployments.

Existing integrations using these headers for App-private authentication must
migrate the caller and authored handler to a dedicated nonreserved header such as
X-App-Token, a provider signature header, or a raw-body signature. There is no
legacy bypass. The platform does not rewrite App source or application data.

- `platform`: explicit x-api-key, then Authorization (native Bearer session or
  live Better Auth Run JWT), then explicit x-hatch-secret or ?secret=, then Cookie.
  An explicitly selected invalid/empty/expired/revoked credential fails without
  fallback. x-hatch-secret presence wins over the query, including an empty header.
  Only a query secret that authenticated the call is removed from the forwarded URL.
  Cookie-only calls require a trusted Origin or same-origin fetch metadata on a
  trusted request origin; cross-site and unproven-origin Cookie requests fail.
  Successful authentication uses the existing per-App raw-body HMAC forwarding.
- `none`: public and unsigned at the platform layer. Invalid incoming platform
  credentials do not reject the call. They are stripped. The App must still verify
  its own authentication, even when its caller has a valid platform key.

No new scopes, roles, resource permissions, CORS policy, DB schema/backfill,
App/Workflow compatibility version or Runner protocol version is introduced.
Interactive management APIs retain their session-only rules.

## CLI

```sh
hatch app invoke webhook my-app --file payload.bin \
  --content-type application/octet-stream --path provider/events \
  --query 'delivery=one two' --header 'X-App-Token: <app-private-token>'
cat payload.bin | hatch app invoke webhook my-app --file - --json
hatch app invoke webhook my-app > response.bin
```

Uses the current profile or complete HATCH_CLI_URL plus exactly one of
HATCH_CLI_TOKEN/HATCH_CLI_API_KEY. Incomplete or invalid environment credentials
never fall back to a stored profile. Environment mode writes no credential/config
files. The CLI performs the current public App lookup for an ID/slug, then calls
only the canonical runtime URL, without obtaining the webhook secret.

Default method is POST with an empty body and application/octet-stream. Set
--content-type explicitly for JSON/text; --file never parses or transforms bytes.
GET/HEAD reject --file. Supported verbs are GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS.
--path accepts nonempty relative segments without traversal, percent escapes,
query, fragment, scheme or leading slash. Repeat --query name=value to encode query
parameters safely; values are literal, including percent characters. Repeat
--header Name:value for App-owned headers. Platform credentials, Cookie, x-hatch-*,
forwarding/routing and hop-by-hop headers cannot be overridden.

Raw response bytes go to stdout without an added newline; use shell redirection to
save binary output. Errors and non-success HTTP status diagnostics go to stderr.
--json emits one object with ok, status, contentType, bodyEncoding (always base64),
and body (base64, including for text). HTTP failure preserves its body/status and
exits nonzero (401: 3, 403: 4, 404: 5, other non-2xx: 7). Standard global
--profile/--config/--workdir/--timeout/help conventions apply. Timeout covers lookup
and invocation. SIGINT exits 130. Requests are never retried and redirects are
refused. A timeout/cancellation can occur after an App mutation: inspect state
before retrying.

## Implementation and completion criteria

The canonical `src/server/auth/credentials.ts` verifier is shared by Platform
Connect, Backend RPC and webhook ingress. The webhook route selects the credential, enforces Cookie CSRF,
and returns ordinary HTTP errors. The shared proxy sanitizes headers, retains the
expectedDeploymentId lifecycle fence, and signs exact bounded bytes in platform
mode. Unsigned request/response bodies retain streaming behavior. Deployment
artifacts, capability and compatibility gates stay authoritative on retained URLs.

Verification covers real production Platform build and installed CLI against a
throwaway PostgreSQL database and deployed App fixture; native credentials and
legacy secrets, invalid mixed credentials and CSRF, header stripping in both modes,
App-owned authentication, raw-body HMAC, methods/subpaths/query/body caps, runtime
lifecycle fences and binary/non-JSON responses. Security/contract regressions,
CLI/runtime/auth checks, types, format, lint and CLI/Platform/Runner builds must
pass. Local evidence is redacted; no external report, publication or deployment.
No database, wire protocol, historical-data or source migration steps are needed;
caller/handler private-header migration is a deliberate integration requirement.
