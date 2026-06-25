/**
 * End-to-end smoke test of the subapp pipeline, exercising the real platform
 * modules: scaffold -> build (codegen + esbuild) -> deploy -> lazy Deno start
 * -> Connect RPC through the platform proxy.
 *
 * Run with: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/e2e-subapp.ts
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { subappBuildDir, subappSrcDir } from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deploySubapp } from '../src/server/subapps/deploy';
import { dropSubappDatabase } from '../src/server/subapps/provision';
import {
  ensureSubappRunning,
  proxySubappRequest,
  stopSubapp,
} from '../src/server/subapps/runtime';
import { createSubapp } from '../src/server/subapps/scaffold';

const ID = 'e2e-counter';

function log(step: string, detail?: unknown) {
  console.log(`\n[${step}]`, detail ?? '');
}

async function cleanup() {
  stopSubapp(ID);
  await db.delete(schema.subapps).where(eq(schema.subapps.id, ID));
  await fs.rm(subappSrcDir(ID), { recursive: true, force: true });
  await fs.rm(subappBuildDir(ID), { recursive: true, force: true });
  await dropSubappDatabase(ID);
}

async function main() {
  log('cleanup prior run');
  await cleanup();

  log('create_subapp');
  const created = await createSubapp({
    id: ID,
    name: 'E2E Counter',
    description: 'Pipeline smoke test',
  });
  console.log('created', created);

  log('deploy_subapp (build + codegen + bundle)');
  const deployed = await deploySubapp(ID);
  console.log('deployed v', deployed.version);
  console.log(
    'normalized manifest:',
    JSON.stringify(deployed.normalized, null, 2),
  );

  log('verify build artifacts');
  const out = subappBuildDir(ID);
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
  const port = await ensureSubappRunning(ID);
  console.log('backend port', port);

  const base = `http://platform/api/subapps/${ID}/rpc`;
  const strip = `/api/subapps/${ID}/rpc`;

  log('RPC Increment(amount=3) via proxy');
  const incRes = await proxySubappRequest(
    ID,
    new Request(`${base}/subapp.v1.CounterService/Increment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 3 }),
    }),
    strip,
  );
  const inc = await incRes.json();
  console.log('  ->', inc);

  log('RPC GetCount via proxy');
  const getRes = await proxySubappRequest(
    ID,
    new Request(`${base}/subapp.v1.CounterService/GetCount`, {
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

  log('PASS: full subapp pipeline works');
  stopSubapp(ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nE2E FAILED:', e);
  stopSubapp(ID);
  process.exit(1);
});
