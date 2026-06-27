/** Server-only: app lifecycle management — archive, rollback, delete. */
import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import {
  deploymentBuildDir,
  appBuildDir,
  appSrcDir,
  appStorageDir,
  appVersionsDir,
  appArtifactsDir,
  appRepoDir,
  AGENTS_DIR,
  deploymentArtifactDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import { moveMasterToDeploymentTag } from './git';
import { dropAppDatabase } from './provision';
import { stopApp } from './runtime';
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
  message: string | null;
  error: string | null;
  buildLog: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
};

/** List an app's deployment history, newest first, with rollback hints. */
export async function listDeployments(
  id: string,
): Promise<DeploymentSummary[]> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  const rows = await db.query.deployments.findMany({
    where: (d, { eq: e }) => e(d.appId, id),
    orderBy: (d, { desc }) => [desc(d.version)],
  });
  const current = app?.currentDeploymentId ?? null;
  return Promise.all(
    rows.map(async (d) => {
      const isCurrent = d.id === current;
      const hasArtifact =
        (d.artifactPath
          ? await pathExists(deploymentArtifactDir(id, d.id))
          : false) || (await pathExists(deploymentBuildDir(id, d.id)));
      return {
        id: d.id,
        version: d.version,
        status: d.status,
        message: d.message,
        error: d.error,
        buildLog: d.buildLog,
        createdAt: d.createdAt.toISOString(),
        isCurrent,
        canRollback:
          !isCurrent &&
          d.status === 'deployed' &&
          Boolean(d.sourceTag) &&
          hasArtifact,
      };
    }),
  );
}

/** Archive (or unarchive) an app. Archiving stops its backend. */
export async function setAppArchived(
  id: string,
  archived: boolean,
): Promise<{ status: schema.AppStatus }> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!app) throw new Error(`App "${id}" not found.`);

  const status: schema.AppStatus = archived
    ? 'archived'
    : app.currentDeploymentId
      ? 'deployed'
      : 'draft';

  await db.update(schema.apps).set({ status }).where(eq(schema.apps.id, id));

  if (archived) stopApp(id);
  // Archived apps must not keep firing cron; restored ones resume.
  await reloadScheduler();
  return { status };
}

/**
 * Roll an app back to a previous deployment by restoring its build snapshot
 * and re-pointing the live build dir + current deployment. Serving reads the
 * normalized manifest from the current deployment, so URLs follow automatically.
 */
export async function rollbackApp(
  id: string,
  deploymentId: string,
): Promise<{ version: number }> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!app) throw new Error(`App "${id}" not found.`);

  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e }) => e(d.id, deploymentId),
  });
  if (!deployment || deployment.appId !== id) {
    throw new Error('Deployment not found for this app.');
  }
  if (deployment.status !== 'deployed') {
    throw new Error('Only successful deployments can be restored.');
  }

  const artifact = deploymentArtifactDir(id, deploymentId);
  const legacySnapshot = deploymentBuildDir(id, deploymentId);
  const snapshot = (await pathExists(artifact)) ? artifact : legacySnapshot;
  if (!(await pathExists(snapshot))) {
    throw new Error(
      `No artifact exists for v${deployment.version}. ` +
        'Only deployments built with artifact support can be restored.',
    );
  }
  if (!deployment.sourceTag) {
    throw new Error(
      `Deployment v${deployment.version} has no source tag and cannot ` +
        'restore source. Run the app Git migration first.',
    );
  }

  const live = appBuildDir(id);
  await fs.rm(live, { recursive: true, force: true });
  await fs.mkdir(live, { recursive: true });
  await fs.cp(snapshot, live, { recursive: true });
  const sourceCommit = await moveMasterToDeploymentTag(
    id,
    deployment.sourceTag,
  );

  const manifest = deployment.manifestNormalized as { name?: string } | null;
  await db
    .update(schema.apps)
    .set({
      status: 'deployed',
      currentDeploymentId: deployment.id,
      currentSourceCommit: sourceCommit,
      name: manifest?.name ?? app.name,
    })
    .where(eq(schema.apps.id, id));

  // Force the backend to restart from the restored build.
  stopApp(id);
  // Reload schedules from the restored deployment's manifest.
  await reloadScheduler();
  return { version: deployment.version };
}

/**
 * Roll back by user-facing version number (e.g. 4 → v4). Resolves the version
 * to its deployment row, then defers to {@link rollbackApp}. This is what the
 * Agent uses, since versions — not opaque deployment ids — are how deployments
 * are referred to everywhere (UI, tags, get_app).
 */
export async function rollbackAppToVersion(
  id: string,
  version: number,
): Promise<{ version: number }> {
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e, and: a }) => a(e(d.appId, id), e(d.version, version)),
  });
  if (!deployment) {
    throw new Error(`App "${id}" has no deployment v${version}.`);
  }
  return rollbackApp(id, deployment.id);
}

/** Permanently delete an app: process, database, rows, and all artifacts. */
export async function deleteApp(id: string): Promise<{ ok: true }> {
  stopApp(id);
  // Drop the per-app database (best-effort; ignore if it never existed).
  try {
    await dropAppDatabase(id);
  } catch {
    /* best-effort */
  }
  // Cascades to deployments, dashboard widgets, and sidebar items.
  await db.delete(schema.apps).where(eq(schema.apps.id, id));

  await Promise.all([
    fs.rm(appSrcDir(id), { recursive: true, force: true }),
    fs.rm(appBuildDir(id), { recursive: true, force: true }),
    fs.rm(appVersionsDir(id), { recursive: true, force: true }),
    fs.rm(appArtifactsDir(id), { recursive: true, force: true }),
    fs.rm(appRepoDir(id), { recursive: true, force: true }),
    fs.rm(appStorageDir(id), { recursive: true, force: true }),
  ]);
  await deleteAgentWorktrees(id);
  // Cancel any scheduled cron jobs for the removed app.
  await reloadScheduler();
  return { ok: true };
}

async function deleteAgentWorktrees(id: string): Promise<void> {
  if (!(await pathExists(AGENTS_DIR))) return;
  const sessions = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
  await Promise.all(
    sessions
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        fs.rm(`${AGENTS_DIR}/${entry.name}/work/${id}`, {
          recursive: true,
          force: true,
        }),
      ),
  );
}
