import { definePlugin } from 'nitro';
import { runMigrations } from '~db/migrate.ts';
import { interruptStaleAgentRuns } from '~server/agent-runs';

export default definePlugin(async () => {
  if (process.env.SKIP_DATABASE_MIGRATIONS === 'true') {
    return;
  }

  await runMigrations();
  await interruptStaleAgentRuns();
});
