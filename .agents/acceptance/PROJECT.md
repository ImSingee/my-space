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

## 8. Agent tool request UI verification

For tool-detail presentation, use a dedicated PostgreSQL container and the
current worktree's production Platform build from sections 2 and 3. The Agent
Runner and a real model provider are not required for deterministic consuming-UI
checks. Seed isolated `agent_sessions.messages` with known assistant tool calls
and their results; confirm the session response contains the seeded arguments,
cold-load `/agent/<sessionId>`, and inspect expanded steps with Playwright.

To inspect live activity, seed an isolated active run with a future lease and
replay deterministic `tool_start` / `tool_end` events over the real events
endpoint, preserving call IDs and original args. This proves the actual chat
stream/reducer/rendering path, not model generation or tool/API execution.
Keep fixtures, cookie state and evidence under the ignored acceptance round;
never modify user records or expose real secrets. A screenshot must visibly
include Request and the corresponding Output/Error; compare parsed visible JSON
to fixture values instead of inferring completeness from page text alone.

## 9. Native mobile verification

Use the Expo development client in `mobile/`, never Expo Go. Resolve the latest
PR branch SHA before building. Run `pnpm --dir mobile exec expo prebuild
--platform ios` and `pnpm --dir mobile ios` against a dedicated Simulator. Changes
to `mobile/plugins/with-private-networking.cjs` require prebuild plus native
compilation and installation; Metro reload cannot apply them.

Use the isolated PostgreSQL, Platform origin, and data directory from section 2.
Development loopback HTTP is allowed only in development clients. A deterministic
loopback OpenAI-compatible provider may exercise the actual Runner and streaming
transport; disclose that it proves client/Runner integration, not model quality.
Static deployed-App fixtures may exercise real handoff/runtime boundaries but do
not prove the deployment builder. Never use production credentials or data.

On Xcode 27, Device Hub may replace the standalone Simulator app. Computer Use
can select the dedicated device there. Probe AXe for native HID/AX operations;
use `simctl io <UDID>` for device screenshots and recordings. Record source SHA,
prebuild/build/install provenance, device model/runtime/UDID, Metro origin, and
all fault injection outcomes. Capture the answer HTTP payload/status and persisted
answer when checking single-choice/Other or duplicate-answer protection.
Keep auth state and fixture secrets private under the ignored round runtime;
upload only sanitized evidence. Stop only this round's services and database.
