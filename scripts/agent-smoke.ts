/**
 * End-to-end smoke test of the *Agent* loop against the real LLM endpoint:
 * seed providers -> create a session -> run one natural-language turn that asks
 * the agent to scaffold and deploy an app -> assert the tools fired and the
 * app ended up deployed.
 *
 * Since the platform/agent-runner split, agent turns execute on a separate
 * runner process. `pnpm dev` starts both platform and runner for normal local
 * development, but this script hosts the platform side itself (internal
 * server + hub on port 3701), so STOP any dev server first (it would occupy
 * the port) and start only a runner:
 *
 *   pnpm dev:runner        # in another terminal
 *   set -a && . ./.env.local && set +a && pnpm exec tsx scripts/agent-smoke.ts
 */
import { eq } from 'drizzle-orm';
import { appBuildDir, appSrcDir } from '../src/agent/paths';
import { seedDefaultProviders } from '../src/agent/seed-providers';
import { db, schema } from '../src/db';
import {
  cancelAgentRun,
  getAgentRun,
  listRunEventsAfter,
  startAgentRun,
} from '../src/server/agent-runs';
import { connectedRunnerCount } from '../src/server/agent-runner/hub';
import { startAgentInternalServer } from '../src/server/agent-runner/internal-server';
import { dropAppDatabase } from '../src/server/apps/provision';
import { stopApp } from '../src/server/apps/runtime';
import { promises as fs } from 'node:fs';

// The app id is now a generated ULID; "agent-demo" is the user-facing slug.
const SLUG = process.env.SMOKE_SLUG ?? 'agent-demo';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
const PROMPT =
  process.env.SMOKE_PROMPT ??
  `Create a new app with slug "${SLUG}" and name "Agent Demo". ` +
    'The default counter template is fine as-is. ' +
    'Then deploy it and reply with the app URL. Keep it minimal.';

/** Remove any prior app using this slug, cleaning resources by its real id. */
async function cleanupBySlug(slug: string) {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.slug, slug),
    columns: { id: true },
  });
  if (!app) return;
  stopApp(app.id);
  await db.delete(schema.apps).where(eq(schema.apps.id, app.id));
  await fs.rm(appSrcDir(app.id), { recursive: true, force: true });
  await fs.rm(appBuildDir(app.id), { recursive: true, force: true });
  await dropAppDatabase(app.id).catch(() => {});
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RUNNER_WAIT_MS = Number(process.env.SMOKE_RUNNER_WAIT_MS ?? 30_000);

/** Host the runner control plane and wait for a runner to register. */
async function waitForRunner() {
  startAgentInternalServer();
  const deadline = Date.now() + RUNNER_WAIT_MS;
  while (connectedRunnerCount() === 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        `no Agent Runner connected within ${RUNNER_WAIT_MS}ms — start one ` +
          'with `pnpm dev:runner` (and stop `pnpm dev`/`pnpm dev:platform` so port 3701 is free).',
      );
    }
    await delay(500);
  }
  console.log('[runner] connected');
}

async function main() {
  console.log('[wait for runner]');
  await waitForRunner();

  console.log('[seed providers]');
  const seeded = await seedDefaultProviders();
  console.log('  seeded:', seeded);

  console.log('[cleanup prior run]');
  await cleanupBySlug(SLUG);

  const [session] = await db
    .insert(schema.agentSessions)
    .values({ title: 'Agent smoke' })
    .returning();
  console.log('[session]', session.id);

  const toolCalls: string[] = [];
  let text = '';
  let errored: string | undefined;
  let terminal = false;
  let seq = 0;

  console.log('[prompt]', PROMPT, '\n');

  const { runId } = await startAgentRun({
    sessionId: session.id,
    userText: PROMPT,
  });

  const deadline = Date.now() + TIMEOUT_MS;
  while (!terminal && Date.now() < deadline) {
    const events = await listRunEventsAfter(runId, seq);
    for (const envelope of events) {
      seq = envelope.seq;
      const event = envelope.event;
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
          terminal = true;
          break;
        case 'done':
        case 'cancelled':
          terminal = true;
          break;
        default:
          break;
      }
    }
    if (!terminal) await delay(250);
  }

  if (!terminal) {
    await cancelAgentRun(runId);
    throw new Error(`agent timed out after ${TIMEOUT_MS}ms`);
  }

  console.log('\n[assistant text]\n', text.trim().slice(0, 1200));
  console.log('\n[tools used]', toolCalls.join(' -> ') || '(none)');

  if (errored) throw new Error(`agent errored: ${errored}`);
  const run = await getAgentRun(runId);
  if (run?.status !== 'completed') {
    throw new Error(`agent run did not complete (status=${run?.status})`);
  }

  const row = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.slug, SLUG),
  });
  console.log(
    '\n[app row]',
    row && { id: row.id, slug: row.slug, status: row.status },
  );

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
  if (row) stopApp(row.id);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nAGENT SMOKE FAILED:', e);
  process.exit(1);
});
