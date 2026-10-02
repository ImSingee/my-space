# Platform-managed SDKs

This directory owns SDK source, public package definitions, and generated
distribution output. These private, versionless packages are materialized by
the platform; Apps and Workflows must not install them or commit `.hatch/`.

| Package           | Authored source                      | Public entrypoints            |
| ----------------- | ------------------------------------ | ----------------------------- |
| `@hatch/app`      | `app/src`                            | `.`, `./data`, `./data/react` |
| `@hatch/workflow` | `workflow/src`                       | `.`, `./manifest`             |
| `@hatch/data`     | None; generated compatibility facade | `.`, `./react`                |

The App root exports `defineAppManifest` and `AppManifestInput`. The Workflow
manifest entry exports `defineWorkflowManifest` and `WorkflowManifestInput`.
Their input types derive from the canonical schemas in
`packages/hatch-manifest/src`, also used by platform validation. Keep shared
contracts there; SDK-only implementation belongs here.

## Build and distribution

Run `pnpm hatch-sdk:build` to build all payloads or `pnpm hatch-sdk:check` to
check SDK source. Package `exports` and `definitions.ts` drive runtime builds,
type entrypoints, and platform resolution. Add an entry's source or re-export
target to the definition when adding a public export.

The build bundles ESM entrypoints with esbuild, sharing chunks within each
package and leaving declared peer dependencies external. It emits declarations
with the repository's TypeScript compiler and asks that compiler for each
package's declaration dependency graph. Only reachable declarations are copied
under `dist/_types`; public declarations re-export them. Public JS entrypoints
carry `@ts-self-types` for Deno. App and Workflow never ship each other's
unrelated schemas or implementations. Common declarations may appear in both
payloads so each remains independently resolvable.

All payloads are built and validated in staging before replacing `dist` trees.
Generated output is ignored by Git. Docker and SDK materialization consume only
each package's `package.json` and `dist`. Runtime loading does not depend on this
repository's source files. Do not replace this process with recursive copying
of another package's entire build directory.

## Legacy Data imports

For currently supported App contracts, `@hatch/data` and `@hatch/data/react`
contain only JS/type re-exports of the corresponding App entrypoints. They do
not duplicate implementations or create new class identities. New source uses
`@hatch/app/data` and `@hatch/app/data/react`; existing source can migrate by
changing those module specifiers without changing schemas or application data.

Historical deployment artifacts are immutable and retain their own runtime
bytes. SDK refresh applies to source worktrees and disposable build inputs.
The proposed removal of legacy Data imports is recorded only in the App
compatibility Skill; no compatibility version is advanced by this refactor.

Platform and Runner must use the same SDK build. Complete both updates before
resuming creation/build tasks. A platform downgrade must retain the new import
entrypoints or restore migrated source imports; deployment rollback continues
using the original artifact. Public npm distribution and independent package
versioning are outside this contract.
