/**
 * End-to-end check of the workflow pipeline: scaffold -> custom multi-step
 * workflow (with a retried step) -> commit -> deploy (bundle + describe) ->
 * manual run -> inspect run + steps, plus an invalid-input run.
 *
 * Run: set -a && . ./.env && set +a && pnpm exec tsx scripts/verify-workflow.ts
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  agentWorkDir,
  agentWorkflowWorkDir,
  workflowArtifactsDir,
  workflowCurrentDir,
  workflowRepoDir,
} from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deployWorkflow } from '../src/server/workflows/deploy';
import { startWorkflowRun } from '../src/server/workflows/execute';
import { getWorkflowRun } from '../src/server/workflows/manage';
import { createWorkflow } from '../src/server/workflows/scaffold';

const ID = 'wf-demo';
const SESSION_ID = 'wf-demo-session';
const worktree = agentWorkflowWorkDir(SESSION_ID, ID);

const MANIFEST = {
  id: ID,
  name: 'Workflow Demo',
  description: 'Greets and exercises a retried step.',
  version: 1,
  entry: 'workflow.ts',
  triggers: {
    cron: [
      {
        name: 'nightly',
        schedule: '0 3 * * *',
        input: { name: 'Cron', times: 1 },
      },
    ],
    webhook: true,
  },
};

const WORKFLOW = `import { defineWorkflow } from '@hatch/workflow';
import { z } from 'zod';

let flakyAttempts = 0;

export default defineWorkflow({
  input: z.object({
    name: z.string().min(1).describe('Who to greet'),
    times: z.number().int().min(1).max(5).default(2),
  }),
  run: async (ctx, input) => {
    const greeting = await ctx.step('build-greeting', () =>
      Array.from({ length: input.times }, () => \`Hello, \${input.name}!\`).join(' '),
    );
    ctx.log('greeting ready');

    const flaky = await ctx.step(
      'flaky-step',
      () => {
        flakyAttempts++;
        if (flakyAttempts < 2) {
          throw new Error('transient failure #' + flakyAttempts);
        }
        return { attempts: flakyAttempts };
      },
      { retry: { maxAttempts: 3, backoffMs: 10 } },
    );

    return { greeting, flaky, count: input.times };
  },
});
`;

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(runId: string) {
  for (let i = 0; i < 100; i++) {
    const run = await getWorkflowRun(runId);
    if (run && ['succeeded', 'failed', 'canceled'].includes(run.status)) {
      return run;
    }
    await sleep(300);
  }
  throw new Error(`run ${runId} did not finish in time`);
}

async function main() {
  // Reset any prior copy.
  await db.delete(schema.workflows).where(eq(schema.workflows.id, ID));
  await Promise.all([
    fs.rm(workflowRepoDir(ID), { recursive: true, force: true }),
    fs.rm(workflowArtifactsDir(ID), { recursive: true, force: true }),
    fs.rm(workflowCurrentDir(ID), { recursive: true, force: true }),
    fs.rm(agentWorkDir(SESSION_ID), { recursive: true, force: true }),
  ]);

  console.log('1) scaffold');
  await createWorkflow(
    { id: ID, name: 'Workflow Demo', description: 'demo' },
    { sessionId: SESSION_ID },
  );

  await fs.writeFile(
    path.join(worktree, 'manifest.json'),
    JSON.stringify(MANIFEST, null, 2),
    'utf8',
  );
  await fs.writeFile(path.join(worktree, 'workflow.ts'), WORKFLOW, 'utf8');
  await runGit(['add', '-A'], worktree);
  await runGit(['commit', '-m', 'Seed workflow demo'], worktree);

  console.log('2) deploy (bundle + describe)');
  const dep = await deployWorkflow(ID, {
    sourceDir: worktree,
    message: 'Initial workflow deployment',
  });
  console.log('   deployed v' + dep.version);
  console.log('   input schema:', JSON.stringify(dep.inputSchema));

  const row = await db.query.workflows.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  console.log('   webhook secret:', row?.webhookSecret);

  console.log('3) manual run (valid input)');
  const ok = await startWorkflowRun(ID, {
    trigger: 'manual',
    input: { name: 'Ada', times: 3 },
  });
  const okRun = await waitForRun(ok.runId);
  console.log('   status:', okRun.status);
  console.log('   output:', JSON.stringify(okRun.output));
  console.log(
    '   steps:',
    okRun.steps
      .map((s) => `${s.seq}:${s.name}[${s.status} a${s.attempt}]`)
      .join(' '),
  );
  if (okRun.log) console.log('   log:', okRun.log.trim());

  console.log('4) manual run (invalid input)');
  const bad = await startWorkflowRun(ID, {
    trigger: 'manual',
    input: { times: 'not-a-number' },
  });
  const badRun = await waitForRun(bad.runId);
  console.log('   status:', badRun.status, '| error:', badRun.error);

  // Each attempt is persisted as its own row, so the retried `flaky-step`
  // contributes two: a failed attempt 1 followed by a successful attempt 2
  // (after the always-succeeding `build-greeting`).
  const pass =
    okRun.status === 'succeeded' &&
    okRun.steps.length === 3 &&
    okRun.steps[1].status === 'failed' &&
    okRun.steps[1].attempt === 1 &&
    okRun.steps[2].status === 'succeeded' &&
    okRun.steps[2].attempt === 2 &&
    badRun.status === 'failed';
  console.log(pass ? '\nVERIFY OK' : '\nVERIFY FAILED');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('VERIFY ERROR:', e);
  process.exit(1);
});
