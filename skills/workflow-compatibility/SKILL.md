---
name: workflow-compatibility
description: Explain Hatch Workflow deployment compatibility versions and guide handling of outdated or unsupported deployments. Use before explaining, updating, or redeploying when list_workflows or get_workflow reports an older compatibility version, a Workflow runtime is disabled by platform compatibility policy, an older deployment was restored, or the user asks about compatibility-version differences.
---

# Workflow Compatibility

## Version meanings

- Deployment version and manifest `compatibilityVersion` are independent values:
  the former automatically increments with each deployment; the latter selects
  the Workflow compatibility contract and is set manually in the source manifest (`manifest.ts` or `manifest.json`).
- Every Workflow manifest must explicitly declare `compatibilityVersion` as a
  positive integer. There is no omitted-field default and no legacy fallback.
- Use `get_workflow` as the source of truth for the live deployment's recorded
  compatibility version.

## Source format compatibility

Current source may use either `manifest.ts` or `manifest.json`; keep exactly one
file. New templates use TS for TypeScript toolchain validation. Preserve the
authored format during ordinary edits, imports, and redeployments. Do not
migrate JSON to TS unless the user explicitly requests the conversion, or as
part of a user-requested upgrade to a released compatibility v3 or later that
requires TS. The latest Workflow contract is v1; v3+ is not available yet.

TypeScript authoring does not introduce a new deployment compatibility version:
the platform still stores parsed source JSON
and normalized deployment JSON, and rollback uses stored deployment artifacts.

A platform build predating TypeScript manifest support cannot necessarily rebuild
TS source with the same `compatibilityVersion`. Upgrade that platform, or use the
new platform's restricted manifest evaluation to materialize equivalent source
JSON, replace the TS file in one commit, and verify the parsed configuration is
unchanged. Do not lower the compatibility declaration to bypass a build failure.
Existing source, deployments, and application data need no automatic migration.

## Version history

### Compatibility v1

Compatibility v1 is the initial Workflow contract. Source must declare
`"compatibilityVersion": 1` at the top level of the source manifest (`manifest.ts` or `manifest.json`) before it can
be deployed.

## Next (proposal)

This section records proposed requirements for future compatibility versions.
These proposals are not active platform policy and do not change the latest or
minimum supported version until they are promoted into the version history
above.

- Compatibility v3 and later will require `manifest.ts`; `manifest.json` will
  no longer be accepted as source for those contracts. When that contract is
  released and the user requests an upgrade, convert the JSON object using
  `defineWorkflowManifest`, remove `manifest.json` in the same change, and run
  the independent manifest check in `building-workflows` before entry checks.
  Until then, preserve JSON unless the user explicitly requests conversion.
  This proposal concerns authored source, not stored deployment JSON, and does
  not introduce or skip any currently unavailable compatibility version.

## Handling compatibility versions

- When the user only asks about version differences, explain the relevant
  entries above without changing or deploying the Workflow.
- A deployment within the platform's supported compatibility range may continue
  running. If a newer version is available, explain it without changing the
  Workflow source or `compatibilityVersion`. Upgrade only when the user
  explicitly requests it and after applying that version's guidance.
- A version below the platform minimum cannot run, including through manual,
  cron, webhook, or App-call triggers. Agent inspection, checkout, and restore
  remain available. After restoring such a deployment, update its manifest and
  source according to the version history, then redeploy it through
  `building-workflows`.
- A version newer than the platform latest also cannot run or be deployed by
  the current platform. Do not lower or remove the source declaration. Update
  the platform instead. Agent inspection, checkout, and restore remain
  available, but a restored deployment stays disabled until the platform is
  updated.
