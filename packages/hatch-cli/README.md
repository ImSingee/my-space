# Hatch CLI

Authentication and App/Workflow source lifecycles, over the typed public oRPC
OpenAPI contract at `/api/v1`. Requires Node >=22.19, Git and pnpm. Deno is
needed to check/run authored App/Workflow code locally. No platform repository
checkout, current-working-directory dependency, or runtime npm dependencies
are needed by the CLI executable.

## Build and install

```sh
pnpm build                  # Platform, Runner, SDKs and CLI
pnpm --dir packages/hatch-cli pack --out dist/hatch-cli-0.1.0.tgz
# In an independent directory:
pnpm add /path/to/hatch-cli-0.1.0.tgz
pnpm exec hatch help
```

`pnpm cli ...` runs source in this repository. The private package is not
published. `scripts/build-cli.ts` bundles the pure contract and client, and
rejects server-only imports in its build graph. The production Dockerfile
installs `/usr/local/bin/hatch` in the shared Platform/Runner image, executable
from any workdir with Node alone. CLI/SDK outputs must be rebuilt before packing.

## Login, profiles and environment credentials

```sh
hatch auth login --url https://hatch.example.com --profile personal
hatch auth login --url https://hatch.example.com --profile personal --no-browser
hatch auth status --profile personal --json
hatch auth logout --profile personal --json
```

Browser approval uses the existing `hatch-cli` device flow. Sign in with the
platform's password/passkey flow, compare the printed code, and approve. The CLI
never collects a password or imports an existing session token. `--no-browser`
prints the URL/code for another device. Polling honors pending/slow-down/expiry;
SIGINT/SIGTERM stops polling without saving. Only an online-verified ordinary
session is saved. All valid sessions, user API keys and Run tokens currently
have full public API authority; there are no CLI scopes or resource ACLs.

Create an API key in Settings using an account session, then save it locally
from a **private regular file** (0600 on Unix):

```sh
hatch auth login --url https://hatch.example.com --profile automation --api-key-file /private/key.txt
hatch auth status --profile automation --json
hatch auth logout --profile automation --local-only --json
```

`--api-key-file` accepts only an API key, verifies it with `x-api-key`, and saves
`apiKey` rather than `token`. No session-token import option exists. API key
management commands are unsupported; the CLI does not turn a key into an account
session and does not invent atomic rotation. Revoke keys in Settings.

Cloud/CI callers inject a complete pair and invoke commands directly:

```sh
HATCH_CLI_URL=https://hatch.example.com HATCH_CLI_API_KEY='<key>' hatch app list --json
HATCH_CLI_URL=https://hatch.example.com HATCH_CLI_TOKEN='<run-jwt>' hatch auth status --json
```

- `HATCH_CLI_URL` + **exactly one** of `HATCH_CLI_TOKEN`/`HATCH_CLI_API_KEY` wins.
  `token` uses Bearer; `apiKey` uses `x-api-key`. Neither is a fleet credential.
- Any present-but-incomplete, empty, whitespace, ambiguous, invalid, expired or
  revoked env credential fails without profile/Cookie fallback. Env plus an
  explicit `--profile` is rejected. URL and credential never mix across sources.
- Env mode never reads/writes CLI credential config, persists tokens, or opens a
  browser. `auth login/logout` rejects externally managed env credentials.
- Otherwise choose explicit `--profile`, active profile, or the sole profile.
  Profiles bind an origin and one credential. The current server has no stable
  instance ID. Requests never follow redirects; device links must be same-origin.
- HTTPS origins are required, except HTTP localhost/127.0.0.1/::1. `auth status`
  has no URL override and verifies online; it never treats local JWT decoding as
  proof. It returns only safe user/key/Run metadata, authority and expiry (null
  for a nonexpiring key), plus source/profile/origin.
- Run JWTs stay in env and are rejected in config. Only the trusted fleet can
  mint/renew them via `/internal/api/runs/:runId/token`; the CLI never reads,
  stores or uses `AGENT_RUNNER_TOKEN`. Host injection/renewal remains outside
  this change. Run status, binding, lease and expiry are checked by the server.

Default config: macOS `~/Library/Application Support/Hatch/cli/config.json`,
Linux `${XDG_CONFIG_HOME:-~/.config}/hatch/cli/config.json`, Windows
`%APPDATA%\Hatch\cli\config.json`. Override with `--config <path>`:

```json
{
  "version": 1,
  "activeProfile": "personal",
  "profiles": {
    "personal": {
      "url": "https://hatch.example.com",
      "token": "<private-session>"
    },
    "automation": {
      "url": "https://other.example.com",
      "apiKey": "<private-key>"
    }
  }
}
```

Credentials are plaintext: keep config private and outside Git. Files must be
regular, nonsymlink, Unix-owner-only; use a private user ACL on Windows. Writes
lock `<config>.lock`, reread latest profiles, fsync a private temporary file, and
rename atomically. Concurrent writes fail with exit 6. Logout rechecks the exact
profile under the lock, so concurrent re-login is preserved. Default session
logout confirms `/api/auth/sign-out` before removal; failure retains the config.
`--local-only` only forgets the profile and explicitly reports `revoked:false`.
API key logout requires this option; it does not revoke the key. After a crash,
remove a stale lock only after confirming no live writer owns it.

## App and Workflow lifecycles

The two resource families share semantics; replace `app` with `workflow`:

```sh
hatch app list --json
hatch app get <id-or-slug> --json
# create.json: {"slug":"notes","name":"Notes","pin":false}
hatch app create --file create.json --directory ./notes --json
cat create.json | hatch app create --file - --workdir ./workspace --json
hatch app clone <id-or-slug> --directory ./notes-copy --json
hatch app update --directory ./notes-copy --json
# Edit source, then git add / git commit yourself.
hatch app deploy --directory ./notes-copy --message 'Release notes' --json
hatch app rollback <id-or-slug> --version 1 --json
```

`--workdir` resolves relative checkout paths (default cwd); no `chdir` to the
platform repository is required. Cloud session workspace directories can be
supplied the same way. Each standalone checkout stores only origin/kind/immutable
ID/generation/source and recovery metadata in `.git/hatch-cli.json`, never
credentials. IDs resolve before slugs on the server. Subsequent operations use
the canonical immutable ID; generation is checked locally and at deployment.

- **Create:** validate JSON with the public contract, register once, materialize
  the returned template into a new staged Git repository, commit the scaffold,
  record identity, and install SDK/dependencies. Existing destinations are never
  overwritten. A response/preparation failure retains its recovery workspace
  and journal; inspect the recorded request/ID and remote state before retrying.
  A created draft with metadata can resume preparation using `update`.
- **Clone:** obtain detail and canonical `master` Git bundle, verify its commit,
  validate the source tree, then create a new checkout. Empty/unpublished source
  is an explicit error; use the original draft workspace for first publication.
- **Update:** require clean source; fetch into `FETCH_HEAD`; merge only when local
  HEAD is an ancestor of remote master. Local ahead/diverged/dirty work is
  retained and rejected. Explicitly merge/rebase from `FETCH_HEAD` yourself.
  Rollback moves platform master to an older release, so an ahead local tree
  also needs an explicit user source decision, never an automatic reset.
- **Deploy:** require clean committed source, validate tracked managed paths,
  upload a real `HEAD` Git bundle with the recorded generation. Platform
  manifest ID/compatibility, build, fast-forward and migration policies remain
  authoritative. No compatibility/protocol bump or source defaults are added.
- **Rollback:** synchronous API call with a real release version; display the
  returned compatibility object and App `dataSchemaMismatch`. Data schema and
  contents are forward-only; rollback does not undo a destructive migration.

SDK preparation uses authenticated `GET /api/v1/sdk/app|workflow`: compiled
`@hatch/app`, legacy `@hatch/data`, or `@hatch/workflow` payloads and import maps
from the **running platform build**. Install into generated `.hatch/` atomically;
never commit it. `pnpm install --ignore-scripts --lockfile=false` installs authored
npm dependencies without changing authored lockfiles. App Connect codegen uses
platform-pinned Buf/protoc-gen-es through pnpm dlx and the platform-owned
`.hatch/buf.gen.yaml`, not an authored plugin configuration. Generated `gen/`
and dependencies are Git-excluded. Commands receive a limited child environment,
including no CLI, fleet, database or provider secrets. This is not a same-UID
sandbox: local dependency/source tooling still runs as the invoking user.

```sh
cd notes-copy
# Check/run with the materialized import map, outside the platform repository.
deno check --import-map .hatch/import-map.json manifest.ts app/main.tsx
# Workflow:
deno check --import-map .hatch/import-map.json manifest.ts workflow.ts
```

Workspace commands use a canonical-path hashed sibling directory lock across
processes, with an owner PID/time record. After a crash, inspect both the lock
and recovery/pending record before manually removing a stale lock. SDK/preparation
failure retains the checkout; retry `update` once repaired. Symlink/submodule/
tracked `.hatch` or `node_modules` source is rejected. No local reset/clean or
unattended authored commit is performed after scaffold creation.

## Migration approval and uncertain outcomes

A destructive App Data Table preview returns `CONFLICT`, readable SQL and an exact
approval token. Review it, then retry the same committed change explicitly:

```sh
hatch app deploy --directory notes-copy --message 'Reviewed migration' \
  --allow-destructive-data-migration --data-migration-approval-token '<exact-token>' --json
```

Both options are required together and forbidden for Workflows. A changed schema
or intervening data schema produces a new approval fingerprint. No automatic
approval or destructive retry is performed. Definite 4xx rejections clear the
pending marker; source/data protection is owned by existing platform services.

Create/deploy/rollback are never automatically retried. Network/5xx/cancel can
leave an unknown server outcome. Deploy fsyncs a pending commit before sending:

```sh
hatch app deploy --directory notes-copy --reconcile --json
# Only after inspecting release history and confirming the previous request ended:
hatch app deploy --directory notes-copy --retry-after-confirming '<pending-commit>' --json
```

Matching source is evidence, not proof of a deployment version or completion.
The explicit retry confirmation is recorded locally; it is not server-side
idempotency. Cancellation does not cancel a platform build already in flight.
Create/rollback uncertainty is reported for manual detail/source/release-history
inspection. No durable operation service or fake async operation IDs are added.

## Output, errors and unsupported commands

`hatch help`, `help app deploy`, `--help`, `version` and `--version` work offline.
`--json` writes a single JSON result or `{ok:false,error:{code,message}}` to
stdout; progress/device instructions use stderr. Branch on code, not prose.
Secrets are redacted; raw exception/auth response diagnostics are not printed.
Auth timeout defaults: login 600s, status/logout 15s; lifecycle requests 30s,
deploy 600s. `--timeout` accepts at most 3600s; subprocess preparation is bounded.

| Exit | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success/help/version                                 |
| 1    | Unexpected CLI failure                               |
| 2    | Arguments/input/config/source selection              |
| 3    | Invalid/expired/revoked credential or ended Run      |
| 4    | Forbidden/denied authorization                       |
| 5    | Resource not found                                   |
| 6    | Lock/source/generation/deployment/migration conflict |
| 7    | Network/timeout/unknown outcome/tool failure         |
| 8    | Explicitly unsupported command                       |
| 130  | Cancellation; inspect any in-flight mutation         |

KV, Data Table queries, raw DB, operation commands and API key management are
reserved/explicitly unsupported, with no platform calls. Platform Agent Tools
remain intact; Tool-to-CLI/Skill migration and custom Agent systems are follow-up.
