---
name: app-compatibility
description: Explain Hatch App deployment compatibility versions and guide handling of outdated or unsupported deployments. Use when list_apps or get_app reports a compatibility update, an App runtime is disabled by the minimum compatibility version, an older deployment was restored, or the user asks what changed between App compatibility versions.
---

# App Compatibility

Use `get_app` as the source of truth for the live deployment's compatibility.
Do not infer compatibility from App source.

## Version meanings

- Deployment version, App manifest `version`, and compatibility version are
  independent values.
- Compatibility is platform-owned deployment metadata. Never edit the manifest,
  deployment records, or generated artifacts to change it.
- Latest compatibility version: `2`.
- Minimum supported compatibility version: `1`.
- A successful `deploy_app` records the latest compatibility version. The Agent
  cannot choose a different target compatibility version.

## Version history

### Compatibility v1

Deployments created before compatibility versions were recorded have no stored
value and are treated as compatibility v1.

### Compatibility v2

Compatibility v2 introduces explicit compatibility-version recording during the
final deployment. It does not introduce an App source or runtime behavior change,
so there are no compatibility-specific source edits or upgrade instructions from
v1 to v2. Redeploying successfully through the current platform records v2.

## Next (proposal)

This section records behavior that current compatibility versions still support
but the next compatibility version proposes to remove. These proposals are not
active platform policy and do not change the latest or minimum supported version
until they are promoted into the version history above.

- `backend.network` will become required. To migrate, add a hostname/IP
  allowlist, `[]`, or `"unrestricted"`, and bind the backend with
  `.listen(port, '127.0.0.1', ...)`. Do not declare the listener or enabled
  Database, Data Tables, KV, and Workflow endpoints; the platform grants them
  automatically. A missing declaration will be rejected, and a restricted
  backend bound elsewhere will fail to start.

## Handling an older version

- When the user only asks about version differences, explain the relevant
  entries above without changing or deploying the App.
- A supported older version may continue running. Explain that a newer
  compatibility version is available.
- If the user asks to update or redeploy, load the full `building-apps` Skill and
  follow its current checkout, validation, commit, and deployment workflow. Do
  not invent compatibility-specific source changes.
- A version below the platform minimum cannot run. Agent inspection, checkout,
  and repair remain available; update and redeploy it through `building-apps`.
- After deployment, call `get_app` again and confirm that compatibility is the
  latest version.
- If the platform reports a compatibility version not documented here, do not
  guess its behavior. Report that this Skill is older than the platform policy.
