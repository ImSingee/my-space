# Install official Hatch product Skills

Run from an external Agent project with the installed Hatch CLI:

```sh
hatch skills list
hatch skills install
hatch skills install building-apps
hatch skills install --skill importing-workflows --json
hatch skills install --skill building-apps --skill building-workflows
hatch skills install --list --json
hatch skills install --workdir /path/to/project --all --yes
```

Installation copies official product instructions into
`<process cwd>/.agents/skills/<name>/SKILL.md` with every supporting resource.
`--workdir` changes the project root. It must already exist. There is no arbitrary
Git URL, registry, agent-specific link, global destination or network fetch.
No login, platform database, package installation, postinstall script, npx, or
credential file is needed. Files work independently of the Hatch repository and
are embedded in the npm/Docker standalone binary at build time.

## Catalog and options

| Skill                    | Additional installed requirements                              |
| ------------------------ | -------------------------------------------------------------- |
| `building-apps`          | `app-compatibility`                                            |
| `building-workflows`     | `workflow-compatibility`, `building-apps` and its requirements |
| `importing-apps`         | `building-apps` and its requirements                           |
| `importing-workflows`    | `building-workflows` and its requirements                      |
| `app-compatibility`      | `building-apps`                                                |
| `workflow-compatibility` | `building-workflows` and its requirements                      |

With no selection, install all six. Positional names and repeated
`-s, --skill <name>` select known names; their required sibling rules are included
automatically so links remain valid. Unknown names fail before creating files.
`--all` explicitly selects the default catalog and cannot accompany named
selection. There is no third-party Skill source or engineering guidance export.
Workflow instructions remain available offline; using Workflows requires the
feature to be enabled on the target platform.

- `hatch skills list` and `hatch skills install -l, --list` discover available
  official Skills, descriptions, dependencies and resource files without writes.
- All commands are noninteractive. `-y, --yes` is accepted for automation and
  does not authorize replacement. No confirmation prompt is required to create
  absent directories.
- `--replace` explicitly replaces differing **selected Skill directories and
  their required dependencies**, including extra files. Review or back up those
  directories first. Unselected/unrelated Skill directories are preserved.
- `--recover` restores an interrupted local transaction, then attempts the
  requested installation using the same conflict/replacement policy.
- `--json` writes one JSON result on stdout. Install results include version,
  source commit, bundle digest, canonical destination, recovery status and each
  Skill's `installed`, `unchanged`, or `replaced` status. Errors use the existing
  `{ "ok": false, "error": { "code": "...", "message": "..." } }` envelope
  and a nonzero exit status. Help is available with `hatch help skills`,
  `hatch skills install --help` and JSON help.

Skills commands accept only their documented options and `--workdir`/`--json`;
authentication profile/config/timeout flags are intentionally unnecessary and
rejected. They do not resolve or use stored or environment API credentials for installation.

## Conflicts, boundaries and interruption

Identical directories are unchanged. Any different, missing, or extra content
(including empty subdirectories) conflicts by default; `--yes` never bypasses
this check. For an intentional replacement:

```sh
hatch skills install building-apps --replace --json
```

The installer rejects symlinks at `.agents`, `skills`, selected Skill directories
and inside selected trees, even with `--replace`. Unrelated Skills, including
their links, are left alone. Names and source paths cannot traverse outside the
Skill root. A symlink used to choose the project root itself is resolved to its
canonical directory, as is the process cwd; all managed paths stay below it.

The entire selection is staged and validated before publishing any directory.
An exclusive `.agents/.hatch-skills-install` transaction serializes cooperating
installers; each Skill is published by a same-filesystem directory rename.
This is a multi-directory transaction: a reader can briefly observe a mixed
selection during publication, but success is reported only after every swap and
an atomic committed journal marker. Ordinary failure or SIGINT/SIGTERM restores
the previous directories. Uncatchable termination retains staged files, backups
and a journal; subsequent normal installs refuse to proceed.

After verifying the installer has stopped, retry with `--recover`. Recovery
refuses live/foreign/unknown owners and changed destination or backup content.
It never overwrites post-interruption edits. Preserve the transaction for manual
inspection if recovery cannot safely restore it. A recovery that is itself
killed may retain a `recovering` marker; verify all installers are stopped and
inspect the journal/backups before removing only that marker and retrying.
Likewise an incomplete/malformed owner file requires manual inspection. Do not
blindly delete the transaction, as it can contain the only previous copy.
The journal is process-crash recovery, not a guarantee against power loss or a
hostile process concurrently replacing filesystem ancestors.

## Source and version alignment

The authoritative product rules remain in repository `skills/`, loaded by the
platform Agent and shipped in the platform image. `.agents/skills/` is repository
engineering guidance and is never exported. `scripts/cli-skills.ts` adapts the six
product Skills during `build:cli`, preserving source/runtime rules, reference
files, import quarantine and compatibility/migration safety while substituting
currently implemented CLI commands for internal Agent tools. Existing platform
Agent tools, prompts and Skill files remain unchanged.

The build embeds the complete adapted trees plus CLI package version, source
revision and SHA-256 digest. The command catalog and compatibility limits come
from the same build's command definitions and compatibility constants; broken
relative links or undeclared sibling requirements fail the build. There is no
separate backend release, runtime repo-path lookup or authenticated retrieval.
Supporting binary assets and scripts are copied as bytes, never executed.

Bundled guidance targets the platform release corresponding to the CLI's source
revision (`hatch version --json`). For a different server release, install its
matching CLI and reinstall its Skills; the installation command cannot negotiate
or discover a remote server version offline. Resource get responses remain the
authority for the target's actual compatibility range and deployment state.
A newer compatibility declaration is never lowered to force deployment.
No Platform/Runner wire contract, public API, authentication authority,
App/Workflow compatibility version or database migration changes here.

## Conventions and local verification

The primary references are [Vercel's Skills CLI](https://github.com/vercel-labs/skills),
its [command reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md),
[agent directories](https://github.com/vercel-labs/skills/blob/main/docs/agents.md)
and [Skill creation rules](https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md).
Like that interface, Hatch supports project-local installation, named selection,
listing and noninteractive usage. Hatch deliberately ships a fixed official
catalog and copies it into `.agents/skills`; it does not implement the upstream
registry, source resolver or per-agent integrations. Standard Skills use a
name-matching directory and `SKILL.md` with YAML `name`/`description` frontmatter,
plus relative resources.

```sh
pnpm build:cli
pnpm exec vitest run --project unit packages/hatch-cli/src/skills.test.ts
```

The durable package tests build and pack the real npm tarball, install it in a
fresh external directory offline without lifecycle scripts, and invoke its CLI.
They cover default and selected installation, standard loading and reference
resolution, idempotence, conflict/replacement, unrelated content, traversal and
symlinks, swap failure restoration, real killed-process recovery, concurrency,
JSON/help and existing command regression. Container and operating-system proof
must be reported separately from host package tests.
