# Hatch acceptance adapter

## 1. Project summary

Hatch is a TanStack Start platform with a separate Agent Runner. App and Workflow
source builders live under src/server; SDKs under packages. This change is
verified through CLI, real builders, PostgreSQL records, and HTTP runtime calls.

## 2. Environment

Use pnpm install --frozen-lockfile and pnpm hatch-sdk:build. Deno and Docker are
required for manifest deployment acceptance. Inspect docker ps before starting
an isolated postgres:17-alpine container with a random loopback port. Never reuse
or stop another task's database. Set DATABASE_URL and APP_DATABASE_URL to that
container and HATCH_DATA_DIR to the acceptance round's private runtime directory.
Build with pnpm build, then start dist/platform/server/index.mjs with Node;
set HOST=127.0.0.1 and PORT to a free port.
APP_URL and AGENT_INTERNAL_PORT must use isolated free ports. Stop only the
processes and container created by the round. Production builds use pnpm build.

## 3. Auth

Use an isolated test owner created through Better Auth signup for HTTP calls.
Keep its cookie in memory. CLI probes call server functions against the isolated
DB; they do not represent authorization API coverage. Never print environment
secrets or cookies. lh acceptance run list --json checks report-upload access.

## 4. Surfaces

CLI: pnpm exec tsx for isolated probes and pnpm test:unit for durable contracts.
Web/API: isolated platform origin from section 2. No existing user browser is needed
for source-manifest behavior. UI layout changes require a separate visual check.

## 5. Project probes and quick navigation

Probe /api/auth/get-session with the test cookie before authenticated requests.
Inspect apps/deployments and workflows/workflow_deployments with the repo's DB
client; invoke deployApp/deployWorkflow on committed test worktrees, then inspect
JSON records and call the deployed App RPC / Workflow execution paths.

## 6. Known constraints

Use a dedicated database and workspace because deploy provisions resource data
and writes Git history. SDK output must exist before materialization. App manifests
are evaluated before RPC codegen. Workflow compatibilityVersion is mandatory.
A successful build alone does not prove deployment or runtime execution.

## 7. Tailscale settings verification

Build the Go helper under `packages/tailscale` with `pnpm tailscale:build`
using the Go version declared in its module. The Agent Runner is not required
for settings verification. Use the isolated Platform, database, and free ports
described above, recording runtime paths and ports in the ignored acceptance
round. Keep test browser storage state private and never publish live Tailscale
authentication URLs.

Drive `/settings/tailscale` with Playwright after authentication. Observe
server-function responses, the `network.tailscale` row in `platform_config`,
and Platform child processes to verify configuration and helper lifecycle.
The helper reports JSON snapshots through its private stdout pipe.

Real tailnet HTTPS verification requires an enrolled test node, HTTPS
certificates, MagicDNS, and a second authorized client. Synthetic connected
snapshots prove only consuming UI and local boundary behavior, never tailnet
connectivity. Missing external enrollment must remain blocked. Keep enrolled
identities and state out of published artifacts.
