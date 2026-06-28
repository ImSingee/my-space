import { definePlugin } from 'nitro';
import { runMigrations } from '~db/migrate.ts';
import { interruptStaleAgentRuns } from '~server/agent-runs';
import { interruptStaleWorkflowRuns } from '~server/workflows/execute';
import { ensureWorkflowScheduler } from '~server/workflows/scheduler';

export default definePlugin(async () => {
  // Skipped only during `pnpm build` (no database yet); at real server startup
  // the flag is unset so migrations run. Everything below touches the database,
  // so it must stay behind this guard or a fresh/preview boot would crash
  // querying tables that don't exist yet.
  if (process.env.SKIP_DATABASE_MIGRATIONS === 'true') {
    return;
  }

  await runMigrations();
  await interruptStaleAgentRuns();

  // Recover orphaned workflow runs first (the in-memory run registry doesn't
  // survive a restart), then (re)start cron timers so deployed schedules fire
  // after a restart without waiting for someone to open the workflows page.
  await interruptStaleWorkflowRuns();
  ensureWorkflowScheduler();
});
