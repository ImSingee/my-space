## Core workflow

1. Use `hatch RESOURCE list --json` to inspect names and slugs. Reuse user-provided
   values; otherwise confirm the intended name and slug before creation. Write a
   local JSON request such as `{"name":"Example","slug":"example","pin":true}`,
   then `hatch RESOURCE create --file <json-path> --directory <path> --json`.
   Hatch generates the immutable id. Never create a duplicate just because local
   preparation failed: inspect the recovery checkout and remote state first.
2. For existing source, inspect `hatch RESOURCE get <id> --json`, then
   `hatch RESOURCE clone <id> --directory <path> --json`. To refresh an existing
   checkout, use `hatch RESOURCE update --directory <path> --json`. Never force
   replacement of local work without explicit authorization. Paths are local;
   keep the exact directory reported by the CLI.
3. Read the actual files. Keep exactly one manifest format and preserve its
   compatibility version during ordinary changes. Create/clone/update prepare
   the platform SDK and locked dependencies. Follow this Skill's source, network,
   dependency-execution and validation rules before committing.
4. Inspect `git status`, stage only authored changes, and commit in that checkout.
   Do not push branches or tags. Use
   `hatch RESOURCE deploy --directory <path> --message <text> --json`.
   On failure, inspect the error and recovery state, fix, validate, commit, retry.
   A destructive data migration requires explicit user approval and the exact
   preview-bound `--data-migration-approval-token` together with
   `--allow-destructive-data-migration`. Never reuse approval after source changes.
5. Inspect `hatch RESOURCE get <id> --json` after deployment and verify the
   requested behavior. Report actual URLs from the response. If master advanced,
   run `hatch RESOURCE update --directory <path> --json` in the same checkout.
   If update reports diverged history, inspect Git state and the fetched commit
   in `FETCH_HEAD`, then rebase onto that commit with `git rebase FETCH_HEAD`.
   Resolve conflicts and revalidate before deploying.
   If deployment was interrupted, use `deploy --reconcile` first; follow CLI
   recovery guidance rather than blindly creating or deploying again.
