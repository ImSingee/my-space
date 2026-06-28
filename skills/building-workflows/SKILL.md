---
name: building-workflows
description: How to design, build, and deploy a Hatch workflow end to end — a single-file Deno program defined with defineWorkflow, a zod v4 input schema, observable retried steps, and manual/cron/webhook triggers. Use this whenever you create or modify a workflow.
---

# Building a Hatch workflow

A **workflow** is a co-equal sibling of an app, but for periodic/repetitive
background tasks. Unlike an app it has **no custom UI or API** — the platform
gives every workflow the same fixed UI for triggering and auditing runs. A
workflow is pure code: a single Deno program (npm imports allowed) that the
platform **bundles into one file** at deploy time and runs on each trigger.

Call `checkout_workflow` before modifying an existing workflow; the source
appears under `<id>/` in your chat's persistent worktree. The platform handles
bundling, versioning (git + artifact), scheduling, and serving the webhook.

## Source layout

```
<id>/
  manifest.json        declares id, name, description, entry, triggers
  workflow.ts          your workflow: defineWorkflow({ input, run })
  deno.json            import map (@hatch/workflow + zod), npm deps go here
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
- Extra npm deps: add them to `deno.json` `imports` with `npm:` specifiers, e.g.
  `"dayjs": "npm:dayjs@^1"`, then `import dayjs from 'dayjs'`.

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
2. For an existing workflow, call `checkout_workflow`.
3. Edit files under `<id>/`.
4. `git status`, `git add ...`, `git commit -m "message"` inside `<id>/`.
5. Call `deploy_workflow` with a required `message`. Deploy bundles the program,
   captures the input JSON Schema, publishes the clean commit, tags
   `deploy/v<version>`, records the artifact, and reloads the cron schedule.

Do not push branches or tags — the platform Git server rejects Agent pushes. If
deploy says `master` advanced, `git fetch origin master`, rebase, resolve, and
deploy again.

## Inspect, run & roll back

- `list_workflows` shows every workflow (id, status, live version, triggers).
- `get_workflow <id>` shows the input schema, triggers, recent runs, and
  deployment history.
- `rollback_workflow` with the `id` and `version` restores that version's bundle
  and source (moves `master` to that commit — re-checkout before further edits).
- Users trigger manual runs and inspect run history (steps, logs, output, errors)
  from the workflow page; you don't run workflows yourself.

## Deploy & iterate

1. New workflow → confirm name/slug → `create_workflow`. Existing → `checkout_workflow`.
2. Read the files, edit `workflow.ts` (input + steps) and `manifest.json`
   (triggers), keeping the zod schema authoritative.
3. Commit with git.
4. `deploy_workflow` with a `message`. On failure, read the build/describe output,
   fix the source, commit, and deploy again.
5. Tell the user what it does, how it's triggered, and where to watch runs.
