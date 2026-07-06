import { definePlugin } from 'nitro';
import { runMigrations } from '~db/migrate.ts';
import {
  ensureAgentRunSweeper,
  sweepExpiredAgentRuns,
} from '~server/agent-runs';
import { startAgentInternalServer } from '~server/agent-runner/internal-server';
import { hardenPlatformDatabase } from '~server/apps/provision';
import { warmLongRunningBackends } from '~server/apps/runtime';
import { ensureScheduler } from '~server/apps/scheduler';
import { ensureRetentionSweep } from '~server/retention';
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
  // Lock down PUBLIC connect on the platform DB so per-app roles (same server)
  // can't open a connection to it. Independent of the rest of boot.
  await hardenPlatformDatabase();
  // Agent runs execute on remote runners: bring up the runner-facing internal
  // server (WS control channel + REST API), then reap only runs whose lease
  // already expired — runs with live leases survive a platform restart, their
  // runner reconnects and resumes streaming.
  startAgentInternalServer();
  await sweepExpiredAgentRuns();
  ensureAgentRunSweeper();

  // Recover orphaned workflow runs first (the in-memory run registry doesn't
  // survive a restart), then (re)start cron timers so deployed schedules fire
  // after a restart without waiting for someone to open the workflows page.
  await interruptStaleWorkflowRuns();
  ensureWorkflowScheduler();
  // Same for app cron jobs: without this they would only start once someone
  // happened to call listApps (its fire-and-forget side effect).
  ensureScheduler();
  // The keep-alive registry is in-memory, so long-running backends stay down
  // after a restart until their first request; boot them proactively.
  await warmLongRunningBackends();
  // Trim unbounded history tables (logs, cron runs, workflow runs, agent run
  // events) daily so a long-lived install doesn't grow without bound.
  ensureRetentionSweep();
});
