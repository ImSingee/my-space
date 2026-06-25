/**
 * End-to-end test of subapp capabilities: storage, cron scheduling, inbound
 * webhooks, and long-running (kept-warm) backends — through real platform
 * modules. A plain node:http Deno backend is staged that uses STORAGE_DIR.
 *
 * Run: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/e2e-capabilities.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  subappBuildDir,
  subappSrcDir,
  subappStorageDir,
  subappVersionsDir,
} from '../src/agent/paths';
import { db, schema } from '../src/db';
import { nextRun, parseCron } from '../src/server/subapps/cron-expr';
import { deploySubapp } from '../src/server/subapps/deploy';
import { dropSubappDatabase } from '../src/server/subapps/provision';
import {
  callSubappBackend,
  isSubappRunning,
  stopSubapp,
} from '../src/server/subapps/runtime';
import {
  reloadScheduler,
  runCronJobNow,
} from '../src/server/subapps/scheduler';
import { createSubapp } from '../src/server/subapps/scaffold';
import {
  deleteObject,
  getObject,
  listObjects,
  putObject,
} from '../src/server/subapps/storage';

const ID = 'caps-test';

function log(step: string, detail?: unknown) {
  console.log(`\n[${step}]`, detail ?? '');
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const MANIFEST = {
  id: ID,
  name: 'Capabilities Test',
  description: 'storage + cron + webhook + long-running',
  version: 1,
  capabilities: {
    database: false,
    frontend: false,
    widgets: false,
    backend: true,
    cron: true,
    webhook: true,
    storage: true,
    workflow: false,
  },
  backendMode: 'long-running',
  backend: { entry: 'backend/main.ts' },
  widgets: [],
  cron: [{ name: 'tick', schedule: '*/1 * * * *', path: '/__cron/tick' }],
};

const BACKEND = `import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const storageDir = Deno.env.get('STORAGE_DIR') ?? './storage';
await mkdir(storageDir, { recursive: true });
const tickFile = path.join(storageDir, 'tick-count.txt');

async function readTicks() {
  try {
    return Number(await readFile(tickFile, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const port = Number(Deno.env.get('PORT') ?? '8080');

http
  .createServer(async (req, res) => {
    const url = req.url ?? '/';
    try {
      if (req.method === 'POST' && url.startsWith('/__cron/tick')) {
        const next = (await readTicks()) + 1;
        await writeFile(tickFile, String(next), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticks: next }));
        return;
      }
      if (req.method === 'POST' && url.startsWith('/__webhook')) {
        const body = await readBody(req);
        await writeFile(
          path.join(storageDir, 'last-webhook.json'),
          body || '{}',
          'utf8',
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true, bytes: body.length }));
        return;
      }
      if (url.startsWith('/health')) {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(port, () => console.log('caps backend on :' + port));
`;

async function cleanup() {
  stopSubapp(ID);
  await db.delete(schema.subapps).where(eq(schema.subapps.id, ID));
  await fs.rm(subappSrcDir(ID), { recursive: true, force: true });
  await fs.rm(subappBuildDir(ID), { recursive: true, force: true });
  await fs.rm(subappVersionsDir(ID), { recursive: true, force: true });
  await fs.rm(subappStorageDir(ID), { recursive: true, force: true });
  await dropSubappDatabase(ID);
}

async function stageSource() {
  const dir = subappSrcDir(ID);
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(MANIFEST, null, 2),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'backend', 'main.ts'), BACKEND, 'utf8');
}

function testCronExpr() {
  // every 5 minutes
  const a = parseCron('*/5 * * * *');
  const next = nextRun(a, new Date('2026-01-01T10:02:00'));
  assert(next?.getMinutes() === 5, '*/5 after 10:02 -> minute 5');

  // daily at 00:00
  const b = parseCron('0 0 * * *');
  const nb = nextRun(b, new Date('2026-01-01T10:00:00'));
  assert(
    nb?.getHours() === 0 && nb?.getMinutes() === 0,
    '0 0 * * * -> next midnight',
  );

  // invalid
  let threw = false;
  try {
    parseCron('99 * * *');
  } catch {
    threw = true;
  }
  assert(threw, 'invalid cron should throw');
}

async function main() {
  log('cleanup prior run');
  await cleanup();

  log('cron-expr unit checks');
  testCronExpr();
  console.log('  cron parsing + nextRun OK');

  log('scaffold + stage capability backend');
  await createSubapp({
    id: ID,
    name: 'Capabilities Test',
    description: 'caps',
  });
  await stageSource();

  log('deploy (long-running, warm start)');
  const dep = await deploySubapp(ID);
  console.log('  deployed v', dep.version, 'cron jobs:', dep.normalized.cron);
  assert(dep.normalized.cron.length === 1, 'normalized cron has 1 job');
  assert(!!dep.normalized.webhook, 'normalized webhook present');
  assert(!!dep.normalized.storage, 'normalized storage present');

  const row = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  assert(row?.status === 'deployed', 'status deployed');
  assert(row?.backendMode === 'long-running', 'backendMode long-running');
  assert(!!row?.webhookSecret, 'webhook secret generated');
  console.log('  webhookSecret', row?.webhookSecret);

  log('long-running: backend warm-started by deploy');
  // Give the warm-start a brief moment in case it is still booting.
  await new Promise((r) => setTimeout(r, 500));
  assert(isSubappRunning(ID), 'backend should be running after deploy');

  log('storage: module roundtrip');
  await putObject(
    ID,
    'hello.txt',
    new TextEncoder().encode('hi there'),
    'text/plain',
  );
  const got = await getObject(ID, 'hello.txt');
  assert(
    got !== null && new TextDecoder().decode(got.body) === 'hi there',
    'stored blob reads back',
  );
  const list1 = await listObjects(ID);
  assert(
    list1.some((o) => o.key === 'hello.txt'),
    'listObjects includes hello.txt',
  );
  const del = await deleteObject(ID, 'hello.txt');
  assert(del, 'deleteObject returns true');
  const got2 = await getObject(ID, 'hello.txt');
  assert(got2 === null, 'deleted blob is gone');

  log('cron: manual trigger writes to storage via backend');
  const r1 = await runCronJobNow(ID, 'tick');
  assert(r1.status === 200, 'cron tick returns 200');
  const c1 = await getObject(ID, 'tick-count.txt');
  assert(
    c1 !== null && new TextDecoder().decode(c1.body).trim() === '1',
    'tick count is 1 after first run',
  );
  await runCronJobNow(ID, 'tick');
  const c2 = await getObject(ID, 'tick-count.txt');
  assert(
    c2 !== null && new TextDecoder().decode(c2.body).trim() === '2',
    'tick count is 2 after second run',
  );
  console.log('  cron fired twice, persisted via STORAGE_DIR');

  log('webhook: backend handler delivers + persists');
  const wh = await callSubappBackend(ID, '/__webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ping', n: 42 }),
  });
  assert(wh.status === 200, 'webhook backend returns 200');
  const last = await getObject(ID, 'last-webhook.json');
  assert(
    last !== null && new TextDecoder().decode(last.body).includes('"n":42'),
    'webhook payload persisted',
  );
  console.log('  webhook delivered:', wh.body);

  // Stop keep-alive before cleanup so it is not auto-restarted.
  stopSubapp(ID);
  await reloadScheduler();

  log('cleanup');
  await cleanup();

  log('PASS: storage + cron + webhook + long-running all work');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\nCAPABILITIES E2E FAILED:', e);
  stopSubapp(ID);
  await cleanup().catch(() => {});
  process.exit(1);
});
