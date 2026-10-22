# External Agent CLI contract

These are official Hatch product usage rules bundled with the installed CLI
from the same platform source revision. They describe Apps and Workflows,
not Hatch repository engineering. Installation is local and offline; it neither
logs in nor runs package scripts. Never execute source merely to install a Skill.

Use `hatch version --json` and `hatch help <command> --json` to inspect the installed
contract. The command catalog below is generated from that CLI's definitions.
Use `hatch app get <id> --json` or `hatch workflow get <id> --json` to read the
selected target's actual compatibility minimum/latest and live deployment.
Bundled rules target the same platform release as this CLI. If the target runs
a different release, obtain its matching CLI and reinstall its Skills before
relying on release-specific guidance. Never lower a compatibility declaration
or treat Next (proposal) as an active contract. Current bundled contracts are
App latest APP_LATEST/minimum APP_MINIMUM and Workflow latest WORKFLOW_LATEST/minimum WORKFLOW_MINIMUM.

For platform commands, authenticate with `hatch auth login --url <platform-url>`
or a Settings-created API key through `auth login --url <url> --api-key-file <path>`.
Existing `HATCH_CLI_URL` with `HATCH_CLI_TOKEN` (native session or valid Run JWT)
or `HATCH_CLI_API_KEY` remain supported; inspect `hatch help auth` and the selected
profile. Valid Run credentials retain full public business authority. Never use
Runner fleet/internal tokens as CLI credentials. Never write tokens, cookies,
secrets, credential files, or runtime environment values into Skills or source.
Business commands use Connect RPC at `/api/rpc`; do not invent REST aliases,
Agent-only tools, custom JWT signing, scopes, or alternative authentication.

Read `references/cli.md` relative to the installed Skill, and use your Agent's
normal local file-reading and user-question capabilities. No platform-only
`ask`, attachment, file, or shell tool is required. Commands containing `<...>`
are templates: substitute concrete values and shell-quote them. Never paste the
angle brackets literally. Global `--workdir` changes the CLI working directory;
use `--directory` for the source checkout when applicable.

Data command input is a local UTF-8 JSON object for structured Data Table query /
mutation (omit the action field; the command selects it). `hatch app kv set`
reads the file as literal text, including an empty file. Data Table SQL and DB
query read literal SQL text, not JSON.
Use `hatch help app --json` for supported flags. Inspect schema first; retain
migration approval and live-data safety rules from the product reference.
Use KV `--cursor` and `--limit` for pagination and `--reveal-secrets` only when
explicitly needed. Omit both `--secret` and `--no-secret` to preserve a KV secret
flag; never confuse CLI options with JSON request fields.

For an import, static review must finish before executing any imported code.
A TS manifest whose version cannot be established statically is a stop condition.
After review, create a fresh destination using the CLI; copy only reviewed
source, preserve destination `.git` and `.hatch`, replace the immutable manifest
id, and remove the template's other manifest format. Use update to refresh SDK
and validate through the current platform preparation; never invent a local
manifest evaluator or copy SDK bytes from an archive.
