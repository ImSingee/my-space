---
name: app-compatibility
description: Explain Hatch App deployment compatibility versions and guide handling of outdated or unsupported deployments. Use before explaining, updating, or redeploying when list_apps or get_app reports an older compatibility version, an App runtime is disabled by the platform minimum, an older deployment was restored, or the user asks about compatibility-version differences.
---

# App Compatibility

## Version meanings

- Deployment version and manifest `compatibilityVersion` are independent values:
  the former is the deployed App version, which automatically increments with
  each deployment; the latter is the compatibility version set manually in
  the source manifest (`manifest.ts` or `manifest.json`).
- Read the source compatibility version from the source manifest (`manifest.ts` or `manifest.json`), defaulting to `2`
  when it is omitted; use `get_app` as the source of truth for the live
  deployment's compatibility version.

## Source format compatibility

Current source may use either `manifest.ts` or `manifest.json`; keep exactly one
file. New templates use TS for TypeScript toolchain validation. Preserve the
authored format during ordinary edits, imports, and redeployments. Do not
migrate JSON to TS unless the user explicitly requests the conversion, or as
part of a user-requested upgrade to a released compatibility v3 or later that
requires TS. The latest App contract is v2; v3+ is not available yet.

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

Deployments created before compatibility versions were recorded have no stored
value and are treated as compatibility v1.

### Compatibility v2

Compatibility v2 introduces explicit compatibility-version recording during the
final deployment. It does not introduce an App source or runtime behavior change,
so upgrading from v1 requires only declaring `"compatibilityVersion": 2` and
redeploying. Source that omits the field defaults to v2.

## Next (proposal)

This section records proposed requirements for future compatibility versions.
These proposals are not active platform policy and do not change the latest or
minimum supported version until they are promoted into the version history
above.

- Compatibility v3 and later will require `manifest.ts`; `manifest.json` will
  no longer be accepted as source for those contracts. When that contract is
  released and the user requests an upgrade, convert the JSON object using
  `defineAppManifest`, remove `manifest.json` in the same change, and run the
  independent manifest check in `building-apps` before codegen and entry checks.
  Until then, preserve JSON unless the user explicitly requests conversion.
  This proposal concerns authored source, not stored deployment JSON.

- Starting with the next App compatibility version (currently proposed v3),
  App SDK imports must use `@hatch/app`, `@hatch/app/data`, or
  `@hatch/app/data/react`. Replace `@hatch/data` with `@hatch/app/data` and
  `@hatch/data/react` with `@hatch/app/data/react`, including type imports,
  re-exports, and dynamic imports. The platform will no longer generate the
  legacy Data stubs or expose their import-map/browser aliases for that version.
  Supported v1/v2 sources retain the stubs; an omitted version still means v2.
  Enforce the policy after restricted TypeScript manifest evaluation, including
  its dependency graph, and before building the remaining source. Refreshing a
  worktree across compatibility versions must remove or restore the stubs.
  This proposal does not itself activate v3 or raise the minimum supported version.

- Omitting `compatibilityVersion` from the source manifest (`manifest.ts` or `manifest.json`) keeps the App on
  compatibility v2. To use any newer compatibility version, declare the target
  as a positive integer at the top level. For example, once compatibility v3 is
  available and its guidance has been applied, set `compatibilityVersion: 3`
  in the `manifest.ts` object passed to `defineAppManifest`.

  Preserve an existing declaration during ordinary edits and choose a newer
  value only after applying that version's guidance.

- Historical fields in the source manifest will no longer be accepted. Remove the
  top-level `version` and `userscripts` fields, and remove
  `capabilities.userscripts`, before targeting a newer compatibility version.

- `backend.network` will become required. To migrate, add a hostname/IP
  allowlist, `[]`, or `"unrestricted"`, and bind the backend with
  `.listen(port, '127.0.0.1', ...)`. Do not declare the listener or enabled
  Database, Data Tables, KV, and Workflow endpoints; the platform grants them
  automatically. A missing declaration will be rejected, and a restricted
  backend bound elsewhere will fail to start.

## Handling an older version

- When the user only asks about version differences, explain the relevant
  entries above without changing or deploying the App.
- A deployment at or above the minimum supported compatibility version may
  continue running. If a newer version is available, explain it without changing
  the App source or `compatibilityVersion`. Upgrade compatibility only when the
  user explicitly requests it.
- A version below the platform minimum cannot run. Agent inspection, checkout,
  and repair remain available; deploy also rejects source below the minimum.
  Update and redeploy it through `building-apps`.
