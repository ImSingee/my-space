/**
 * End-to-end smoke test of the *Agent* loop against the real LLM endpoint:
 * seed providers -> create a session -> run one natural-language turn that asks
 * the agent to scaffold and deploy an app -> assert the tools fired and the
 * app ended up deployed.
 *
 * Run with: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/agent-smoke.ts
 */
import { eq } from 'drizzle-orm';
import { appBuildDir, appSrcDir } from '../src/agent/paths';
import { runAgentTurn } from '../src/agent/runtime';
import { seedDefaultProviders } from '../src/agent/seed-providers';
import { db, schema } from '../src/db';
import { dropAppDatabase } from '../src/server/apps/provision';
import { stopApp } from '../src/server/apps/runtime';
import { promises as fs } from 'node:fs';

const ID = process.env.SMOKE_ID ?? 'agent-demo';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const PROMPT =
  process.env.SMOKE_PROMPT ??
  `Create a new app with id "${ID}" and name "Agent Demo". ` +
    'The default counter template is fine as-is. ' +
    'Then deploy it and reply with the app URL. Keep it minimal.';

async function cleanup() {
  stopApp(ID);
  await db.delete(schema.apps).where(eq(schema.apps.id, ID));
  await fs.rm(appSrcDir(ID), { recursive: true, force: true });
  await fs.rm(appBuildDir(ID), { recursive: true, force: true });
  await dropAppDatabase(ID);
}

async function main() {
  console.log('[seed providers]');
  const seeded = await seedDefaultProviders();
  console.log('  seeded:', seeded);

  console.log('[cleanup prior run]');
  await cleanup();

  const [session] = await db
    .insert(schema.agentSessions)
    .values({ title: 'Agent smoke' })
    .returning();
  console.log('[session]', session.id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const toolCalls: string[] = [];
  let text = '';
  let errored: string | undefined;

  console.log('[prompt]', PROMPT, '\n');

  await runAgentTurn({
    sessionId: session.id,
    userText: PROMPT,
    signal: controller.signal,
    emit: (event) => {
      switch (event.type) {
        case 'tool_start':
          toolCalls.push(event.name);
          console.log(
            `  -> tool_start: ${event.name}`,
            JSON.stringify(event.args),
          );
          break;
        case 'tool_end':
          console.log(
            `  <- tool_end:   ${event.name}${event.isError ? ' (ERROR)' : ''}`,
          );
          break;
        case 'text':
          text += event.delta;
          break;
        case 'error':
          errored = event.message;
          console.error('  !! error:', event.message);
          break;
        default:
          break;
      }
    },
  });

  clearTimeout(timer);

  console.log('\n[assistant text]\n', text.trim().slice(0, 1200));
  console.log('\n[tools used]', toolCalls.join(' -> ') || '(none)');

  if (errored) throw new Error(`agent errored: ${errored}`);

  const row = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  console.log('\n[app row]', row && { id: row.id, status: row.status });

  if (!toolCalls.includes('create_app')) {
    throw new Error('agent did not call create_app');
  }
  if (!toolCalls.includes('deploy_app')) {
    throw new Error('agent did not call deploy_app');
  }
  if (row?.status !== 'deployed') {
    throw new Error(`app not deployed (status=${row?.status})`);
  }

  console.log('\nPASS: agent scaffolded + deployed an app from NL.');
  stopApp(ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nAGENT SMOKE FAILED:', e);
  stopApp(ID);
  process.exit(1);
});
