/**
 * End-to-end test of app management: versioned deploys, rollback, archive,
 * and delete — through the real platform modules.
 *
 * Run: set -a && . ./.env.local && set +a && pnpm exec tsx scripts/e2e-manage.ts
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { appBuildDir, appSrcDir, appVersionsDir } from '../src/agent/paths';
import { db, schema } from '../src/db';
import { deployApp } from '../src/server/apps/deploy';
import {
  deleteApp,
  listDeployments,
  rollbackApp,
  setAppArchived,
} from '../src/server/apps/manage';
import { dropAppDatabase } from '../src/server/apps/provision';
import { stopApp } from '../src/server/apps/runtime';
import { createApp } from '../src/server/apps/scaffold';

const ID = 'mgmt-test';

function log(step: string, detail?: unknown) {
  console.log(`\n[${step}]`, detail ?? '');
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function cleanup() {
  stopApp(ID);
  await db.delete(schema.apps).where(eq(schema.apps.id, ID));
  await fs.rm(appSrcDir(ID), { recursive: true, force: true });
  await fs.rm(appBuildDir(ID), { recursive: true, force: true });
  await fs.rm(appVersionsDir(ID), { recursive: true, force: true });
  await dropAppDatabase(ID);
}

async function setManifestName(name: string) {
  const file = path.join(appSrcDir(ID), 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.name = name;
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

async function currentName(): Promise<string | undefined> {
  const row = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  return row?.name;
}

async function main() {
  log('cleanup prior run');
  await cleanup();

  log('create + deploy v1 (name "Mgmt V1")');
  await createApp({ id: ID, name: 'Mgmt V1', description: 'mgmt test' });
  const v1 = await deployApp(ID);
  console.log('  v1 deploymentId', v1.deploymentId, 'version', v1.version);

  log('edit name -> deploy v2 (name "Mgmt V2")');
  await setManifestName('Mgmt V2');
  const v2 = await deployApp(ID);
  console.log('  v2 deploymentId', v2.deploymentId, 'version', v2.version);
  assert((await currentName()) === 'Mgmt V2', 'current name should be Mgmt V2');

  log('list deployments');
  const list = await listDeployments(ID);
  for (const d of list) {
    console.log(
      `  v${d.version} ${d.status}` +
        `${d.isCurrent ? ' [current]' : ''}` +
        `${d.canRollback ? ' [rollback]' : ''}`,
    );
  }
  assert(list.length === 2, 'should have 2 deployments');
  const top = list[0];
  const prev = list[1];
  assert(top.version === 2 && top.isCurrent, 'v2 should be current');
  assert(prev.version === 1 && prev.canRollback, 'v1 should be rollback-able');

  log('rollback to v1');
  const rb = await rollbackApp(ID, prev.id);
  console.log('  restored version', rb.version);
  assert(rb.version === 1, 'rolled back to v1');
  assert((await currentName()) === 'Mgmt V1', 'name should revert to Mgmt V1');

  const liveManifest = JSON.parse(
    await fs.readFile(
      path.join(appBuildDir(ID), 'manifest.normalized.json'),
      'utf8',
    ),
  );
  assert(liveManifest.name === 'Mgmt V1', 'live build dir restored to v1');

  const afterRb = await listDeployments(ID);
  assert(
    afterRb.find((d) => d.version === 1)?.isCurrent === true,
    'v1 should now be current',
  );

  log('archive');
  const arch = await setAppArchived(ID, true);
  assert(arch.status === 'archived', 'status archived');
  log('unarchive');
  const unarch = await setAppArchived(ID, false);
  assert(unarch.status === 'deployed', 'status back to deployed');

  log('delete');
  await deleteApp(ID);
  const gone = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, ID),
  });
  assert(!gone, 'app row removed');
  assert(!existsSync(appSrcDir(ID)), 'source dir removed');
  assert(!existsSync(appBuildDir(ID)), 'build dir removed');
  assert(!existsSync(appVersionsDir(ID)), 'versions dir removed');

  log('PASS: versioned deploy + rollback + archive + delete all work');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('\nMANAGE E2E FAILED:', e);
  await cleanup().catch(() => {});
  process.exit(1);
});
