---
name: workflow-compatibility
description: Explain Hatch Workflow deployment compatibility versions and guide handling of outdated or unsupported deployments. Use before explaining, updating, or redeploying when list_workflows or get_workflow reports an older compatibility version, a Workflow runtime is disabled by platform compatibility policy, an older deployment was restored, or the user asks about compatibility-version differences.
---

# Workflow Compatibility

## Version meanings

- Deployment version and manifest `compatibilityVersion` are independent values:
  the former automatically increments with each deployment; the latter selects
  the Workflow compatibility contract and is set manually in `manifest.json`.
- Every Workflow manifest must explicitly declare `compatibilityVersion` as a
  positive integer. There is no omitted-field default and no legacy fallback.
- Use `get_workflow` as the source of truth for the live deployment's recorded
  compatibility version.

## Version history

### Compatibility v1

Compatibility v1 is the initial Workflow contract. Source must declare
`"compatibilityVersion": 1` at the top level of `manifest.json` before it can
be deployed.

## Next (proposal)

This section records proposed requirements for future compatibility versions.
These proposals are not active platform policy and do not change the latest or
minimum supported version until they are promoted into the version history
above.

No future Workflow compatibility changes are currently proposed.

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
