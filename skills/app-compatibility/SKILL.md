---
name: app-compatibility
description: Explain Hatch App deployment compatibility versions and guide handling of outdated or unsupported deployments. Use before explaining, updating, or redeploying when list_apps or get_app reports an older compatibility version, an App runtime is disabled by the platform minimum, an older deployment was restored, or the user asks about compatibility-version differences.
---

# App Compatibility

## Version meanings

- Deployment version and manifest `compatibilityVersion` are independent values:
  the former is the deployed App version, which automatically increments with
  each deployment; the latter is the compatibility version set manually in
  `manifest.json`.
- Read the source compatibility version from `manifest.json`, defaulting to `2`
  when it is omitted; use `get_app` as the source of truth for the live
  deployment's compatibility version.

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

- Omitting `compatibilityVersion` from `manifest.json` keeps the App on
  compatibility v2. To use any newer compatibility version, declare the target
  as a positive integer at the top level. For example, once compatibility v3 is
  available and its guidance has been applied:

  ```json
  {
    "compatibilityVersion": 3
  }
  ```

  Preserve an existing declaration during ordinary edits and choose a newer
  value only after applying that version's guidance.

- Historical fields in `manifest.json` will no longer be accepted. Remove the
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
