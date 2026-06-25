/**
 * End-to-end smoke test of the app pipeline, exercising the real platform
 * modules: scaffold -> build (codegen + esbuild) -> deploy -> lazy Deno start
 * -> Connect RPC through the platform proxy.
 *
 * Run with: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/e2e-app.ts
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { appBuildDir, appSrcDir } from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deployApp } from '../src/server/apps/deploy';
import { dropAppDatabase } from '../src/server/apps/provision';
import {
  ensureAppRunning,
  proxyAppRequest,
  stopApp,
} from '../src/server/apps/runtime';
import { createApp } from '../src/server/apps/scaffold';

const ID = 'e2e-counter';

function log(step: string, detail?: unknown) {
  console.log(`\n[${step}]`, detail ?? '');
}

async function cleanup() {
  stopApp(ID);
  await db.delete(schema.apps).where(eq(schema.apps.id, ID));
  await fs.rm(appSrcDir(ID), { recursive: true, force: true });
  await fs.rm(appBuildDir(ID), { recursive: true, force: true });
  await dropAppDatabase(ID);
}

async function main() {
  log('cleanup prior run');
  await cleanup();

  log('create_app');
  const created = await createApp({
    id: ID,
    name: 'E2E Counter',
    description: 'Pipeline smoke test',
  });
  console.log('created', created);

  log('deploy_app (build + codegen + bundle)');
  const deployed = await deployApp(ID);
  console.log('deployed v', deployed.version);
  console.log(
    'normalized manifest:',
    JSON.stringify(deployed.normalized, null, 2),
  );

  log('verify build artifacts');
  const out = appBuildDir(ID);
  const expected = [
    'app/index.html',
    'app/app.js',
    'widgets/counter.js',
    'backend/main.ts',
    'gen/service_pb.ts',
    'deno.json',
    'manifest.normalized.json',
  ];
  for (const rel of expected) {
    const ok = existsSync(path.join(out, rel));
    console.log(ok ? '  ok ' : '  MISSING ', rel);
    if (!ok) throw new Error(`missing artifact: ${rel}`);
  }

  log('ensure backend running (lazy Deno start)');
  const port = await ensureAppRunning(ID);
  console.log('backend port', port);

  const base = `http://platform/api/apps/${ID}/rpc`;
  const strip = `/api/apps/${ID}/rpc`;

  log('RPC Increment(amount=3) via proxy');
  const incRes = await proxyAppRequest(
    ID,
    new Request(`${base}/app.v1.CounterService/Increment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 3 }),
    }),
    strip,
  );
  const inc = await incRes.json();
  console.log('  ->', inc);

  log('RPC GetCount via proxy');
  const getRes = await proxyAppRequest(
    ID,
    new Request(`${base}/app.v1.CounterService/GetCount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    strip,
  );
  const got = await getRes.json();
  console.log('  ->', got);

  if (got.count !== 3) {
    throw new Error(`expected count=3, got ${JSON.stringify(got)}`);
  }

  log('PASS: full app pipeline works');
  stopApp(ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nE2E FAILED:', e);
  stopApp(ID);
  process.exit(1);
});
