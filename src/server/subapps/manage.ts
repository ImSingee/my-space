/** Server-only: subapp lifecycle management — archive, rollback, delete. */
import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import {
  deploymentBuildDir,
  subappBuildDir,
  subappSrcDir,
  subappStorageDir,
  subappVersionsDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import { dropSubappDatabase } from './provision';
import { stopSubapp } from './runtime';
import { reloadScheduler } from './scheduler';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export type DeploymentSummary = {
  id: string;
  version: number;
  status: schema.DeploymentStatus;
  error: string | null;
  buildLog: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
};

/** List a subapp's deployment history, newest first, with rollback hints. */
export async function listDeployments(
  id: string,
): Promise<DeploymentSummary[]> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  const rows = await db.query.deployments.findMany({
    where: (d, { eq: e }) => e(d.subappId, id),
    orderBy: (d, { desc }) => [desc(d.version)],
  });
  const current = subapp?.currentDeploymentId ?? null;
  return Promise.all(
    rows.map(async (d) => {
      const isCurrent = d.id === current;
      const hasSnapshot = await pathExists(deploymentBuildDir(id, d.id));
      return {
        id: d.id,
        version: d.version,
        status: d.status,
        error: d.error,
        buildLog: d.buildLog,
        createdAt: d.createdAt.toISOString(),
        isCurrent,
        canRollback: !isCurrent && d.status === 'deployed' && hasSnapshot,
      };
    }),
  );
}

/** Archive (or unarchive) a subapp. Archiving stops its backend. */
export async function setSubappArchived(
  id: string,
  archived: boolean,
): Promise<{ status: schema.SubappStatus }> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!subapp) throw new Error(`Subapp "${id}" not found.`);

  const status: schema.SubappStatus = archived
    ? 'archived'
    : subapp.currentDeploymentId
      ? 'deployed'
      : 'draft';

  await db
    .update(schema.subapps)
    .set({ status })
    .where(eq(schema.subapps.id, id));

  if (archived) stopSubapp(id);
  // Archived subapps must not keep firing cron; restored ones resume.
  await reloadScheduler();
  return { status };
}

/**
 * Roll a subapp back to a previous deployment by restoring its build snapshot
 * and re-pointing the live build dir + current deployment. Serving reads the
 * normalized manifest from the current deployment, so URLs follow automatically.
 */
export async function rollbackSubapp(
  id: string,
  deploymentId: string,
): Promise<{ version: number }> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!subapp) throw new Error(`Subapp "${id}" not found.`);

  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e }) => e(d.id, deploymentId),
  });
  if (!deployment || deployment.subappId !== id) {
    throw new Error('Deployment not found for this subapp.');
  }
  if (deployment.status !== 'deployed') {
    throw new Error('Only successful deployments can be restored.');
  }

  const snapshot = deploymentBuildDir(id, deploymentId);
  if (!(await pathExists(snapshot))) {
    throw new Error(
      `No build snapshot exists for v${deployment.version}. ` +
        'Only deployments built with snapshot support can be restored.',
    );
  }

  const live = subappBuildDir(id);
  await fs.rm(live, { recursive: true, force: true });
  await fs.mkdir(live, { recursive: true });
  await fs.cp(snapshot, live, { recursive: true });

  const manifest = deployment.manifestNormalized as { name?: string } | null;
  await db
    .update(schema.subapps)
    .set({
      status: 'deployed',
      currentDeploymentId: deployment.id,
      name: manifest?.name ?? subapp.name,
    })
    .where(eq(schema.subapps.id, id));

  // Force the backend to restart from the restored build.
  stopSubapp(id);
  // Reload schedules from the restored deployment's manifest.
  await reloadScheduler();
  return { version: deployment.version };
}

/** Permanently delete a subapp: process, database, rows, and all artifacts. */
export async function deleteSubapp(id: string): Promise<{ ok: true }> {
  stopSubapp(id);
  // Drop the per-subapp database (best-effort; ignore if it never existed).
  try {
    await dropSubappDatabase(id);
  } catch {
    /* best-effort */
  }
  // Cascades to deployments, dashboard widgets, and sidebar items.
  await db.delete(schema.subapps).where(eq(schema.subapps.id, id));

  await Promise.all([
    fs.rm(subappSrcDir(id), { recursive: true, force: true }),
    fs.rm(subappBuildDir(id), { recursive: true, force: true }),
    fs.rm(subappVersionsDir(id), { recursive: true, force: true }),
    fs.rm(subappStorageDir(id), { recursive: true, force: true }),
  ]);
  // Cancel any scheduled cron jobs for the removed subapp.
  await reloadScheduler();
  return { ok: true };
}
