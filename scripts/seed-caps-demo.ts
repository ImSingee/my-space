/**
 * Seed a persistent demo app that exercises storage + cron + webhook +
 * long-running, so the platform UI and the public webhook route have real data.
 *
 * Run: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/seed-caps-demo.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  appBuildDir,
  appSrcDir,
  appStorageDir,
  appVersionsDir,
} from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deployApp } from '../src/server/apps/deploy';
import { dropAppDatabase } from '../src/server/apps/provision';
import { stopApp } from '../src/server/apps/runtime';
import { createApp } from '../src/server/apps/scaffold';

const ID = 'caps-demo';

const MANIFEST = {
  id: ID,
  name: 'Capabilities Demo',
  description: 'Storage, cron, webhook and a long-running backend.',
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
  cron: [{ name: 'heartbeat', schedule: '*/5 * * * *', path: '/__cron/beat' }],
};

const BACKEND = `import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const storageDir = Deno.env.get('STORAGE_DIR') ?? './storage';
await mkdir(storageDir, { recursive: true });
const beatFile = path.join(storageDir, 'heartbeats.txt');

async function readBeats() {
  try {
    return Number(await readFile(beatFile, 'utf8')) || 0;
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
      if (req.method === 'POST' && url.startsWith('/__cron/beat')) {
        const next = (await readBeats()) + 1;
        await writeFile(beatFile, String(next), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ beats: next, at: new Date().toISOString() }));
        return;
      }
      if (req.method === 'POST' && url.startsWith('/__webhook')) {
        const body = await readBody(req);
        await writeFile(
          path.join(storageDir, 'last-webhook.json'),
          JSON.stringify({ at: new Date().toISOString(), body }),
          'utf8',
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: true, bytes: body.length }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(port, () => console.log('caps-demo backend on :' + port));
`;

async function main() {
  // Reset any prior copy.
  stopApp(ID);
  await db.delete(schema.apps).where(eq(schema.apps.id, ID));
  await fs.rm(appSrcDir(ID), { recursive: true, force: true });
  await fs.rm(appBuildDir(ID), { recursive: true, force: true });
  await fs.rm(appVersionsDir(ID), { recursive: true, force: true });
  await fs.rm(appStorageDir(ID), { recursive: true, force: true });
  await dropAppDatabase(ID).catch(() => {});

  await createApp({
    id: ID,
    name: 'Capabilities Demo',
    description: 'demo',
  });
  const dir = appSrcDir(ID);
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(MANIFEST, null, 2),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'backend', 'main.ts'), BACKEND, 'utf8');

  const dep = await deployApp(ID);
  const row = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  console.log('deployed', ID, 'v' + dep.version);
  console.log('webhookSecret', row?.webhookSecret);
  console.log('webhook URL', `/api/hooks/${ID}?secret=${row?.webhookSecret}`);
  // Stop the warm backend started in THIS process; the dev server will lazily
  // boot + keep it alive on first request / scheduled tick.
  stopApp(ID);
  process.exit(0);
}

main().catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});
