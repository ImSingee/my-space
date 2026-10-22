# Hatch CLI inside Agent Runs

The installed `hatch` command automatically uses the executing Run's full public
business authority at Connect RPC `/api/rpc`. It needs no login or profile. The
existing App and Workflow tools remain available. This introduces no new scopes,
ACL, App/Workflow compatibility contract, or public business endpoint.

## Configuration and network

`APP_URL` remains the canonical public origin used by Better Auth and displayed
to the Agent. The Runner uses `HATCH_PLATFORM_URL` for its authenticated internal
control connection. `HATCH_RUNNER_CLI_URL` independently selects the business API
origin reachable from Runner subprocesses; it defaults to `APP_URL`. Compose sets
it to `http://app:3700`, because host `localhost` is not the Platform inside the
Runner container. Use HTTPS outside a trusted deployment network. Never point the
CLI at the internal control port. Local user profiles retain their HTTPS policy
and their existing login/logout behavior.

The Platform optionally accepts `HATCH_RUN_TOKEN_TTL_SECONDS` (integer 5–300,
default 300). This only shortens native Better Auth Run credentials, and is useful
for validating renewal. The signing keys, issuer, audience, verification and live
Run/assignment/lease policy are unchanged.

## Process lifecycle

1. Scheduling persists the active Run and its assigned Runner before `run.start`.
   `run.accepted` finalizes session workspace affinity. The Runner constructs a
   credential provider bound to that Run, session, Runner and abort signal.
2. Before each `run_command` spawn, the provider calls the existing
   fleet-authenticated `POST /internal/api/runs/:id/token`. The Platform requires
   a connected Runner and a currently active, correctly assigned, live lease.
3. Only that command receives `HATCH_CLI_URL`, `HATCH_CLI_TOKEN` (Run JWT), and a
   transient loopback credential endpoint and random channel secret. Credentials
   are supplied in the per-spawn environment, never in the captured execution
   environment, global Runner environment or tool arguments.
4. Each installed CLI process obtains a fresh JWT from that command's channel
   before resolving its environment credentials. Thus `hatch …; sleep …; hatch …`
   works across expiry within one shell. Credentials remain in memory; no CLI
   profile is read as a fallback or written. A stale/closed channel is an error.
5. Each renewal rechecks the control connection and the Platform's live binding.
   A mint request has a three-second timeout and at most three attempts, with
   200/400 ms delays for transient errors. Authorization failures stop immediately.
   Responses must match all three identity fields and have at least two seconds
   remaining according to the server Date header, allowing its second precision.
   No CLI business operation is automatically replayed.
6. The loopback endpoint requires its command-specific random bearer secret.
   It allows four concurrent requests and 1024 issuances per command, with bounded
   HTTP timeouts and at most 16 connections. It runs only while the command executes; there is no renewal
   interval. Command completion, timeout, abort, stale assignment and shutdown
   close the endpoint and cancel in-flight mint requests.

During disconnect the local channel fails closed. After a successful control
handshake, each future CLI start rechecks the current binding. Stale runs are
aborted by reconciliation; workspace removal waits for their execution to settle.
The Platform's existing live checks reject old tokens after end, cancellation,
assignment changes or lease expiry. A disconnected Runner's already-issued token
remains subject to the existing lease policy until expiry; no new revocation
mechanism is introduced.

## Secret and runtime boundaries

Fleet secrets, cookies, user sessions, API keys and provider credentials are not
used as CLI credentials. The provider is passed only to the command tool; source
checkout, file tools, App/Workflow builders and deployment runtime environments
do not receive it. Runner-generated credentials are never written to `.env`,
profile files, source bundles or deployment artifacts. The command tool redacts
issued JWTs and its channel secret from captured stdout/stderr, including values
split across chunks, and uses fixed value-free renewal errors. Neither the CLI
nor the credential channel logs credentials.

An authorized command can read its own environment and pass it to its own
children. It can also deliberately transform, persist or transmit values; literal
output redaction is not a general exfiltration prevention boundary. OS session
sandboxing and the command-specific secret protect other Runs and the Runner's
fleet credentials. Do not put the injected environment into application source,
configuration, diagnostics, or artifacts.

## Local verification

Run `pnpm build` first. Use a disposable loopback PostgreSQL server with permission to create databases.
The suite creates and drops its own isolated database. Run:

```sh
HATCH_RUNNER_CLI_TEST_DATABASE_URL=postgres://… \
  pnpm exec vitest run --project unit src/runner/cli.integration.test.ts
```

The integration suite starts the production Platform and Runner bundles, installs
the built CLI into a private PATH, and dispatches Runs through the real scheduling
HTTP endpoint. Only model responses are deterministic fixtures. Credentials,
lease checks, process spawns, CLI auth and Connect operations are real. The suite
uses a five-second native token lifetime and separate Platform/Runner data roots.
It tests concurrent Run identities, sequential calls after expiry, disposable
resource creation, terminal/cancellation/assignment rejection and secret-free
transcripts/configs. It neither publishes nor uses production data.
