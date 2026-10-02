# Source manifests

App and Workflow templates use `manifest.ts`. Existing `manifest.json` packages
remain supported without migration. The source root must contain exactly one;
two files are an error, and a broken TS manifest never falls back to JSON.

## Authoring

```ts
import { defineAppManifest } from '@hatch/app';

export default defineAppManifest({
  id: 'my-app',
  name: 'My App',
  compatibilityVersion: 2,
  capabilities: { frontend: true },
  app: { entry: 'app/main.tsx' },
});
```

```ts
import { defineWorkflowManifest } from '@hatch/workflow/manifest';

export default defineWorkflowManifest({
  id: 'daily-sync',
  name: 'Daily Sync',
  compatibilityVersion: 1,
  entry: 'workflow.ts',
  network: [],
  triggers: { cron: [], webhook: false },
});
```

`AppManifestInput` and `WorkflowManifestInput` are also exported from the same
respective modules for `satisfies` declarations. Helpers do not fill defaults or
perform platform operations. The platform validates values with the same Zod
contracts used to derive the input types. App version omission retains the
existing v2 default; Workflow `compatibilityVersion` remains mandatory.

These SDK modules are materialized under `.hatch/` and resolved by its import
map. Do not add `@hatch/*` packages to dependency files, edit generated SDK files,
or commit them. Restore a missing SDK through checkout/preparation.

## Checking and evaluation

After preparing locked dependencies, check the TS manifest independently:

```sh
deno check --config=deno.json --no-remote --node-modules-dir=manual \
  --import-map=.hatch/import-map.json --lock=deno.lock --frozen ./manifest.ts
```

Then follow the resource's building Skill for codegen and entry checks. A
manifest is needed before RPC generation: share constants through pure source
modules, not generated code or App/Workflow execution entries. Workflow input
schemas continue to live in `workflow.ts`.

The default export must be a plain JSON configuration object, not a factory or
Promise. Imports may use local source and locked pure dependencies. Evaluation
cannot access environment variables, network, file writes, subprocesses or FFI.
Its permissions are independent of the declared backend/Workflow network policy.
Imports cannot escape the source root or use remote modules. Evaluation has a
30-second timeout and a 1 MB output limit.

Omit optional properties instead of assigning `undefined`. Functions, BigInt,
non-finite numbers, class instances, custom serialization, accessors, sparse
arrays and circular values are rejected. TypeScript checking does not replace
runtime validation of paths, cross-field requirements, or serializability.

## Persistence and conversion

Commit the selected source file and its referenced modules. The platform saves
parsed source JSON and normalized deployment JSON; deployed runtimes and
artifact rollback do not execute the TS manifest again. Do not maintain a
generated root `manifest.json` alongside TS.

To adopt TS, wrap the existing JSON object with the appropriate helper, preserve
the immutable id and compatibility version, remove the JSON file in the same
commit, and verify equivalent parsed configuration before deploying. Existing
deployments and application data require no migration.

An older platform may understand the deployment compatibility version but lack
the TS loader. Upgrade it before importing/rebuilding TS source. If JSON source
is required, materialize the evaluated source object using the updated platform's
restricted loader, replace TS with JSON, and verify equivalence. Never execute
unreviewed imported TS in the platform process or use unrestricted shell eval
as a conversion shortcut. Exported source archives preserve their authored format.
