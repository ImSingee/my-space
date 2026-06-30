/**
 * F7 verification: apps can declare + call top-level workflows via the existing
 * external workflow API. Covers four layers:
 *   1. getCallableWorkflow(): resolves a deployed+webhook-enabled workflow, and
 *      returns null for missing/uncallable ids.
 *   2. manifest parse/normalize: workflows[] is backend-gated, aliases default to
 *      the workflow id, duplicate aliases are rejected.
 *   3. runtime env injection: a deployed backend-only app receives HATCH_WORKFLOWS
 *      with { workflow, name, url, secret } for each declared alias.
 *   4. end-to-end call: the app POSTs to the injected url with the secret and the
 *      platform starts a real workflow run.
 *
 * Run (match the live dev server's data dir + DB + auth URL):
 *   direnv exec . env HATCH_DATA_DIR=../my-space-data \
 *     pnpm tsx scripts/verify-f7.ts
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  appArtifactsDir,
  appBuildDir,
  appRepoDir,
  appSrcDir,
} from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deployApp } from '../src/server/apps/deploy';
import { ensureAppRepo } from '../src/server/apps/git';
import {
  normalizeManifest,
  parseSourceManifest,
} from '../src/server/apps/manifest';
import { callAppBackend, stopApp } from '../src/server/apps/runtime';
import { createApp } from '../src/server/apps/scaffold';
import { getCallableWorkflow } from '../src/server/workflows/external';

const TARGET_WORKFLOW = process.env.F7_WORKFLOW ?? 'wf-demo';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`, detail !== undefined ? detail : '');
  }
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

async function runIdsFor(workflowId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, workflowId));
  return new Set(rows.map((r) => r.id));
}

async function main(): Promise<void> {
  // -- 1) getCallableWorkflow -------------------------------------------------
  console.log('[1] getCallableWorkflow');
  const callable = await getCallableWorkflow(TARGET_WORKFLOW);
  check(`${TARGET_WORKFLOW} is callable`, callable !== null, callable);
  check(
    'callable.path is the external webhook route',
    callable?.path === `/api/workflow-hooks/${TARGET_WORKFLOW}`,
    callable?.path,
  );
  check('callable.secret present', Boolean(callable?.secret));
  const bogus = await getCallableWorkflow('definitely-not-a-real-workflow');
  check('unknown workflow resolves to null', bogus === null);

  // -- 2) manifest parse / normalize ------------------------------------------
  console.log('[2] manifest workflows[] schema');
  const backendManifest = parseSourceManifest({
    id: 'tmp-f7',
    name: 'tmp',
    capabilities: { backend: true },
    backend: { entry: 'backend/main.ts' },
    workflows: [
      { workflow: TARGET_WORKFLOW },
      { workflow: 'other', alias: 'o' },
    ],
  });
  const backendNorm = normalizeManifest(backendManifest);
  check(
    'backend app: workflows normalized with default alias = id',
    backendNorm.workflows?.[0]?.alias === TARGET_WORKFLOW &&
      backendNorm.workflows?.[0]?.workflow === TARGET_WORKFLOW,
    backendNorm.workflows,
  );
  check(
    'backend app: explicit alias preserved',
    backendNorm.workflows?.[1]?.alias === 'o',
    backendNorm.workflows,
  );

  const noBackendNorm = normalizeManifest(
    parseSourceManifest({
      id: 'tmp-f7b',
      name: 'tmp',
      capabilities: { frontend: true },
      app: { entry: 'app/main.tsx' },
      workflows: [{ workflow: TARGET_WORKFLOW }],
    }),
  );
  check(
    'no-backend app: workflows omitted from normalized manifest',
    noBackendNorm.workflows === undefined,
    noBackendNorm.workflows,
  );

  // backend capability WITHOUT a backend entry must not advertise workflows:
  // there is no process to receive HATCH_WORKFLOWS, so the calls can't fire.
  const capOnlyNorm = normalizeManifest(
    parseSourceManifest({
      id: 'tmp-f7d',
      name: 'tmp',
      capabilities: { backend: true },
      workflows: [{ workflow: TARGET_WORKFLOW }],
    }),
  );
  check(
    'backend cap without backend.entry: workflows omitted',
    capOnlyNorm.workflows === undefined,
    capOnlyNorm.workflows,
  );

  let dupRejected = false;
  try {
    parseSourceManifest({
      id: 'tmp-f7c',
      name: 'tmp',
      capabilities: { backend: true },
      backend: { entry: 'backend/main.ts' },
      workflows: [
        { workflow: 'a', alias: 'dup' },
        { workflow: 'b', alias: 'dup' },
      ],
    });
  } catch {
    dupRejected = true;
  }
  check('duplicate alias rejected by schema', dupRejected);

  // -- 3 & 4) deploy a backend-only app + verify injection + real call --------
  console.log('[3+4] deploy backend-only caller app + inject + call');
  const slug = `f7-caller-${Date.now().toString(36)}`;
  const { id } = await createApp({ slug, name: 'F7 Caller', pin: false });
  console.log(`  created app id=${id} slug=${slug}`);

  let deployed = false;
  try {
    const repoPath = await ensureAppRepo(id);
    const srcDir = appSrcDir(id);
    // Replace the scaffold with a minimal backend-only tree we fully control.
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.mkdir(path.join(srcDir, 'backend'), { recursive: true });
    await fs.writeFile(
      path.join(srcDir, 'manifest.json'),
      JSON.stringify(
        {
          id,
          name: 'F7 Caller',
          version: 1,
          capabilities: { backend: true },
          backendMode: 'serverless',
          backend: { entry: 'backend/main.ts' },
          workflows: [{ workflow: TARGET_WORKFLOW, alias: 'greet' }],
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(srcDir, 'backend', 'main.ts'),
      `const registry = JSON.parse(Deno.env.get('HATCH_WORKFLOWS') ?? '{}');
const port = Number(Deno.env.get('PORT') ?? '8000');
Deno.serve({ port, hostname: '127.0.0.1' }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/env') {
    return Response.json({ registry });
  }
  if (url.pathname === '/call' && req.method === 'POST') {
    const wf = registry['greet'];
    if (!wf) return Response.json({ error: 'no greet alias', registry }, { status: 500 });
    const input = await req.json().catch(() => ({}));
    const res = await fetch(wf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hatch-secret': wf.secret },
      body: JSON.stringify(input),
    });
    const body = await res.text();
    return Response.json({
      upstreamStatus: res.status,
      upstreamBody: body,
      url: wf.url,
      workflow: wf.workflow,
      name: wf.name,
    });
  }
  return new Response('ok');
});
`,
      'utf8',
    );
    await fs.writeFile(path.join(srcDir, '.gitignore'), 'node_modules/\n');

    git(['init', '--initial-branch', 'master'], srcDir);
    git(['remote', 'add', 'origin', repoPath], srcDir);
    git(['config', 'user.email', 'verify@hatch.local'], srcDir);
    git(['config', 'user.name', 'F7 Verify'], srcDir);
    git(['add', '-A'], srcDir);
    git(['commit', '-m', 'f7 verify'], srcDir);

    const before = await runIdsFor(TARGET_WORKFLOW);

    const result = await deployApp(id, {
      sourceDir: srcDir,
      message: 'f7 verify deploy',
    });
    deployed = true;
    check(
      'deployed normalized manifest carries workflows',
      result.normalized.workflows?.[0]?.workflow === TARGET_WORKFLOW &&
        result.normalized.workflows?.[0]?.alias === 'greet',
      result.normalized.workflows,
    );

    // 3) The backend should see HATCH_WORKFLOWS with the resolved url + secret.
    const env = await callAppBackend(id, '/env');
    const envJson = JSON.parse(env.body) as {
      registry?: Record<
        string,
        { workflow?: string; name?: string; url?: string; secret?: string }
      >;
    };
    const greet = envJson.registry?.greet;
    check('backend received HATCH_WORKFLOWS.greet', Boolean(greet), envJson);
    check(
      'injected url is absolute + points at the workflow hook',
      greet?.url ===
        `http://localhost:3700/api/workflow-hooks/${TARGET_WORKFLOW}`,
      greet?.url,
    );
    check('injected secret present', Boolean(greet?.secret));
    check('injected workflow id correct', greet?.workflow === TARGET_WORKFLOW);

    // 4) The backend calls the workflow through the injected config.
    const call = await callAppBackend(id, '/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'f7-verify' }),
    });
    const callJson = JSON.parse(call.body) as {
      upstreamStatus?: number;
      upstreamBody?: string;
    };
    check(
      'workflow hook accepted the call (202)',
      callJson.upstreamStatus === 202,
      callJson,
    );
    let startedRunId: string | undefined;
    try {
      startedRunId = (
        JSON.parse(callJson.upstreamBody ?? '{}') as {
          runId?: string;
        }
      ).runId;
    } catch {
      /* ignore */
    }
    check('hook response includes a runId', Boolean(startedRunId), callJson);

    const after = await runIdsFor(TARGET_WORKFLOW);
    const newRuns = [...after].filter((r) => !before.has(r));
    check('a new workflow run was created', newRuns.length >= 1, {
      newRuns,
      startedRunId,
    });

    // Keep the workflow's history clean: drop runs created by this test.
    if (newRuns.length > 0) {
      for (const runId of newRuns) {
        await db
          .delete(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, runId));
      }
    }
  } finally {
    // Cleanup the throwaway app + its on-disk artifacts.
    stopApp(id);
    await db
      .delete(schema.apps)
      .where(eq(schema.apps.id, id))
      .catch(() => {});
    await fs
      .rm(appSrcDir(id), { recursive: true, force: true })
      .catch(() => {});
    await fs
      .rm(appBuildDir(id), { recursive: true, force: true })
      .catch(() => {});
    await fs
      .rm(appRepoDir(id), { recursive: true, force: true })
      .catch(() => {});
    await fs
      .rm(appArtifactsDir(id), { recursive: true, force: true })
      .catch(() => {});
    if (!deployed) console.log('  (app was not deployed; cleaned up)');
  }

  console.log(`\nF7 verify: ${passed} passed, ${failed} failed`);
  // deployApp() reloads the cron scheduler, which spawns in-process Deno
  // backends that keep the event loop alive; exit explicitly.
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nF7 VERIFY CRASHED:', e);
  process.exit(1);
});
