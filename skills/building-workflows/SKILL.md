---
name: building-workflows
description: How to design, build, and deploy a Hatch workflow end to end — a single-file Deno program defined with defineWorkflow, a zod v4 input schema, observable retried steps, Deno-installed npm dependencies, and manual/cron/webhook triggers. Use this whenever you create or modify a workflow.
---

# Building a Hatch workflow

A **workflow** is a co-equal sibling of an app, but for periodic/repetitive
background tasks. Unlike an app it has **no custom UI or API** — the platform
gives every workflow the same fixed UI for triggering and auditing runs. A
workflow is pure code: a single Deno program (npm imports allowed) that the
platform **bundles into one file** at deploy time and runs on each trigger.

Call `checkout_workflow` before modifying an existing workflow; the source
defaults to `workflows/<id>/`, but the returned absolute path is authoritative.
The platform handles bundling, versioning (git + artifact), scheduling, and
serving the webhook.

## Source layout

```
workflows/<id>/
  manifest.json        declares id, name, description, entry, triggers
  workflow.ts          your workflow: defineWorkflow({ input, run })
  package.json         npm dependencies (installed only with Deno)
  deno.json            reviewed npm lifecycle-script allowlist
  deno.lock            Deno dependency lock (commit this file)
  hatch/workflow.ts    the platform SDK — DO NOT EDIT
```

`create_workflow` scaffolds a runnable greeting example you adapt in place. Read
the exact files before editing.

## The workflow program

Write `workflow.ts` against `@hatch/workflow`. Define the **input schema with
zod v4** and a `run` function. Return a JSON-serializable result.

```ts
import { defineWorkflow } from '@hatch/workflow';
import { z } from 'zod';

export default defineWorkflow({
  // Persisted as JSON Schema on deploy; drives the manual-run form and
  // validates EVERY trigger (manual, cron, webhook) before run starts.
  input: z.object({
    repo: z.string().min(1).describe('owner/name'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  run: async (ctx, input) => {
    // Wrap meaningful units of work in ctx.step so each is recorded
    // (start/finish + every retry) and visible in the run inspector.
    const data = await ctx.step(
      'fetch',
      async () => {
        const res = await fetch(`https://api.github.com/repos/${input.repo}`);
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        return res.json();
      },
      { retry: { maxAttempts: 3, backoffMs: 500 } }, // exponential (factor 2)
    );

    ctx.log(`stars: ${data.stargazers_count}`); // goes to the run log

    return { stars: data.stargazers_count, limit: input.limit };
  },
});
```

- `ctx.step(name, fn, { retry })` — retry options: `maxAttempts` (default 1, no
  retry), `backoffMs` (default 0), `factor` (default 2). A step that throws on
  every attempt fails the run.
- `ctx.log(...)` — appends to the run log.
- `ctx.runId` — the current run id.
- If you omit `input`, the workflow takes no input.

### Runtime constraints

- Runs on Deno with **net + env + read** only (no write/run/ffi). `fetch` works;
  there is no per-workflow database or storage yet.
- **No AI calls** during a run.
- Keep the result JSON-serializable. Do all real work inside `ctx.step` so the
  inspector is useful.
- Do **not** edit `hatch/` — it's the platform SDK, bundled automatically.
- Extra npm deps go in `package.json` `dependencies`, then use a bare import such
  as `import dayjs from 'dayjs'`. Keep the scaffolded `@hatch/workflow` →
  `./hatch/workflow.ts` mapping in `deno.json` so local Deno tooling resolves the
  SDK; do not add the SDK to `package.json` or change/remove that mapping. The
  platform injects the same authoritative mapping again during deploy.

### Dependencies and lifecycle scripts

**Deno is the only package manager.** Never run `npm install`, `pnpm install`,
or generate npm/pnpm lock files. After every dependency change, run this in the
workflow source root:

```bash
deno install --package-json --node-modules-dir=auto --lock=deno.lock
```

Commit `package.json`, `deno.json`, and the resulting `deno.lock`; never commit
`node_modules`. `deploy_workflow` repeats the install with `--frozen`. Missing or
stale files fail deploy. If deploy reports a legacy deno.json-only source, load
this Skill, move every `npm:` import into `package.json`, run the command above,
and commit all three files before deploying again.

Deno skips npm `preinstall`, `install`, and `postinstall` scripts by default. If
it reports a skipped lifecycle script, do not enable it blindly:

1. Find the exact resolved version in `deno.lock`; inspect the package's
   lifecycle command and every local script it invokes.
2. Choose another dependency if it downloads or executes unreviewed remote
   code, reads credentials/project-external files, writes outside the package or
   project, changes global configuration, elevates privileges, is obfuscated or
   dynamic, or cannot be fully traced.
3. Reject native addons, FFI, runtime sidecars, and generated runtime files that
   cannot be carried by the single-file Workflow bundle.
4. Only after confirming the exact command is safe, add the exact locked version
   to `deno.json`—never `true`, a tag, wildcard, or range:

   ```json
   { "allowScripts": ["npm:trusted-package@1.2.3"] }
   ```

5. Run Deno install again, verify the output and Workflow, then commit
   `deno.json` and `deno.lock`. Review transitive packages independently.

## Manifest & triggers

`manifest.json` declares the id/name and the triggers. The input schema is NOT
in the manifest — it is derived from your zod schema at deploy time.

```json
{
  "id": "star-digest",
  "name": "Star digest",
  "description": "Summarize a repo's stars",
  "version": 1,
  "entry": "workflow.ts",
  "triggers": {
    "cron": [
      {
        "name": "daily",
        "schedule": "0 9 * * *",
        "input": { "repo": "denoland/deno" }
      }
    ],
    "webhook": true
  }
}
```

- **Manual**: always available from the workflow page; the form is inferred from
  the input JSON Schema.
- **cron**: each job has a `name`, a standard 5-field `schedule`
  (`minute hour day-of-month month day-of-week`), and a fixed `input` object
  that must satisfy the input schema.
- **webhook**: set `"webhook": true`. On deploy the platform generates a secret
  and exposes a PUBLIC endpoint `/api/workflow-hooks/<id>?secret=<secret>`. POST
  a JSON body (used as the run input) or GET with query params. The secret may
  also be sent as the `x-hatch-secret` header.

## Git workflow

1. For a new workflow, confirm the name + slug with the user via `ask` (the name
   is editable later; the slug is permanent — it keys the URL, repo, and webhook).
   Only then call `create_workflow`. Pass `pin: true` (default) to pin it to the
   sidebar.
2. For an existing workflow, call `checkout_workflow` and keep the returned
   source path. Checkout only creates a missing target by default; use the
   existing path or another `target_path` on conflict. Pass the same path with
   `force: true` only to permanently discard and replace it.
3. Edit files under the exact returned source path.
4. `git status`, `git add ...`, `git commit -m "message"` there.
5. Call `deploy_workflow` with that `source_path` and a required `message`.
   Deploy bundles the program, captures the input JSON Schema, publishes the
   clean commit, tags `deploy/v<version>`, records the artifact, and reloads the
   cron schedule.

Do not push branches or tags — the platform Git server rejects Agent pushes. If
deploy says `master` advanced, call `checkout_workflow` with the same
`target_path` to refresh its origin bundle (the existing-target error preserves
files), then `git fetch origin master`, rebase, resolve, and deploy again.

## Inspect, run & roll back

- `list_workflows` shows every workflow (id, status, live version, triggers).
- `get_workflow <id>` shows the input schema, triggers, recent runs, and
  deployment history.
- `rollback_workflow` with the `id` and `version` restores that version's bundle
  and source but does not modify existing Agent worktrees. To preserve local
  work, refresh with the same checkout target and fetch/rebase; to exactly
  replace it with rollback source, use the same `target_path` and `force: true`.
- Users trigger manual runs and inspect run history (steps, logs, output, errors)
  from the workflow page; you don't run workflows yourself.

## Deploy & iterate

1. New workflow → confirm name/slug → `create_workflow`. Existing →
   `checkout_workflow` and retain its returned source path.
2. Read the files, edit `workflow.ts` (input + steps) and `manifest.json`
   (triggers), keeping the zod schema authoritative.
3. Commit with git.
4. `deploy_workflow` with that `source_path` and a `message`. On failure, read
   the build/describe output, fix the source, commit, and deploy again.
5. Tell the user what it does, how it's triggered, and where to watch runs.
