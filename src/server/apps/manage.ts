/** Server-only: app lifecycle management — archive, rollback, delete. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
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
import { appDeployLock } from './deploy';
import { moveMasterToDeploymentTag, worktreeOrigin } from './git';
import {
  type NormalizedManifest,
  isValidAppId,
  isValidAppSlug,
} from './manifest';
import { dropAppDatabase } from './provision';
import { ensureAppRunning, setKeepAlive, stopApp } from './runtime';
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
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
  /** Commit on the app's `master` branch this version was built from. */
  sourceCommit: string | null;
  /** Immutable `deploy/v<version>` Git tag for this version. */
  sourceTag: string | null;
  /** Whether the build artifact still exists on disk (required to restore). */
  hasArtifact: boolean;
  /** Whether a build log exists; the log itself is fetched lazily on expand. */
  hasBuildLog: boolean;
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
        createdAt: d.createdAt.toISOString(),
        isCurrent,
        sourceCommit: d.sourceCommit,
        sourceTag: d.sourceTag,
        hasArtifact,
        hasBuildLog: Boolean(d.buildLog),
        canRollback:
          !isCurrent &&
          d.status === 'deployed' &&
          Boolean(d.sourceTag) &&
          hasArtifact,
      };
    }),
  );
}

/**
 * Fetch a single deployment's build log on demand. Kept out of the
 * {@link listDeployments} payload so opening the management page doesn't ship
 * every (potentially large) build log up front — the UI fetches this only when
 * a row's log is expanded.
 */
export async function deploymentBuildLog(
  appId: string,
  deploymentId: string,
): Promise<string | null> {
  const d = await db.query.deployments.findFirst({
    where: (row, { eq: e, and: a }) =>
      a(e(row.appId, appId), e(row.id, deploymentId)),
  });
  return d?.buildLog ?? null;
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
 * Change an app's mutable URL slug. The slug only appears in the human-facing
 * `/app/<slug>/` URL, so this is a cheap rename: no rebuild and no FK churn
 * (everything technical is keyed off the immutable `id`). Enforces shape and
 * uniqueness; the unique index on `slug` is the final backstop against races.
 */
export async function renameAppSlug(
  id: string,
  rawSlug: string,
): Promise<{ slug: string }> {
  const slug = rawSlug.trim();
  if (!isValidAppSlug(slug)) {
    throw new Error(
      'Slug must be kebab-case (lowercase letters, digits, and hyphens, ' +
        'starting with a letter).',
    );
  }

  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
    columns: { id: true, slug: true },
  });
  if (!app) throw new Error(`App "${id}" not found.`);
  if (app.slug === slug) return { slug };

  // Reject a slug that matches any other app's id OR slug: id-first resolution
  // means a slug equal to another app's id would shadow it at /app/<slug>/.
  const { slugConflictExists } = await import('./access');
  if (await slugConflictExists(slug, id)) {
    throw new Error(
      `Slug "${slug}" conflicts with an existing app's id or slug.`,
    );
  }

  await db.update(schema.apps).set({ slug }).where(eq(schema.apps.id, id));
  return { slug };
}

/**
 * Roll an app back to a previous deployment by restoring its build snapshot
 * and re-pointing the live build dir + current deployment. Serving reads the
 * normalized manifest from the current deployment, so URLs follow automatically.
 * Serialized with deploys via the shared per-app lock so a rollback and a
 * deploy can't interleave their artifact/Git/row mutations and leave the DB
 * pointing at one version while the live dir/`master` points at another
 * (mirrors rollbackWorkflow).
 */
export function rollbackApp(
  id: string,
  deploymentId: string,
): Promise<{ version: number }> {
  return appDeployLock.withLock(id, () => rollbackAppInner(id, deploymentId));
}

async function rollbackAppInner(
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
  const sourceTag = deployment.sourceTag;
  const manifest = deployment.manifestNormalized as NormalizedManifest | null;

  // Mutate the live build dir, Git master, and the app row under the same
  // advisory lock deploy holds for its version→tag→record step, so a concurrent
  // deploy on another process blocks until we finish (and vice versa).
  await db.transaction(async (tx) => {
    await appDeployLock.acquire(tx, id);
    const live = appBuildDir(id);
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(live, { recursive: true });
    await fs.cp(snapshot, live, { recursive: true });
    const sourceCommit = await moveMasterToDeploymentTag(id, sourceTag);

    await tx
      .update(schema.apps)
      .set({
        status: 'deployed',
        currentDeploymentId: deployment.id,
        currentSourceCommit: sourceCommit,
        name: manifest?.name ?? app.name,
        // Restore the rolled-back version's full metadata too. Otherwise the row
        // keeps the newer deployment's capabilities/backendMode/description — e.g.
        // the cron scheduler reads app.capabilities.cron and would skip jobs the
        // restored version actually defines (mirrors what the deploy path writes).
        description: manifest?.description || null,
        capabilities: manifest?.capabilities ?? app.capabilities,
        backendMode: manifest?.backendMode ?? app.backendMode,
        manifest: deployment.manifestNormalized ?? app.manifest,
        // Rollback must also bump the served userscript `@version`: Tampermonkey
        // only fetches when the remote version INCREASES, so re-serving the old
        // deployment's number (v3 → v2) would read as "older" and installed
        // scripts would never receive the rolled-back code.
        userscriptRevision: sql`${schema.apps.userscriptRevision} + 1`,
      })
      .where(eq(schema.apps.id, id));
  });

  // Force the backend to restart from the restored build, then re-apply the
  // keep-alive contract for the *restored* manifest: rolling back to/from a
  // long-running backend must flip warm-start accordingly (stopApp cleared it).
  stopApp(id);
  const longRunning =
    manifest?.backendMode === 'long-running' &&
    Boolean(manifest?.capabilities?.backend);
  if (longRunning) {
    setKeepAlive(id, true);
    try {
      await ensureAppRunning(id);
    } catch {
      /* warm-start is best-effort; requests will retry the boot */
    }
  }
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
  // The id flows into `fs.rm(..., { force: true })` on several per-app dirs, so
  // reject anything that isn't a valid app slug before touching the filesystem.
  // Otherwise a crafted id like "../../src" (which matches no DB row) would
  // still resolve outside the app namespace and delete arbitrary directories.
  if (!isValidAppId(id)) {
    throw new Error(`Invalid app id: ${id}`);
  }
  stopApp(id);
  // Drop the per-app database (best-effort; ignore if it never existed).
  try {
    await dropAppDatabase(id);
  } catch {
    /* best-effort */
  }
  // Cascades to deployments, dashboard widgets, and sidebar items.
  await db.delete(schema.apps).where(eq(schema.apps.id, id));

  // Remove agent worktrees before the bare repo: deleteAgentWorktrees() scopes
  // each checkout to this app via its git origin, which must still resolve
  // against the not-yet-deleted repo or a stale worktree would be left behind.
  await deleteAgentWorktrees(id);
  await Promise.all([
    fs.rm(appSrcDir(id), { recursive: true, force: true }),
    fs.rm(appBuildDir(id), { recursive: true, force: true }),
    fs.rm(appVersionsDir(id), { recursive: true, force: true }),
    fs.rm(appArtifactsDir(id), { recursive: true, force: true }),
    fs.rm(appRepoDir(id), { recursive: true, force: true }),
    fs.rm(appStorageDir(id), { recursive: true, force: true }),
  ]);
  // Cancel any scheduled cron jobs for the removed app.
  await reloadScheduler();
  return { ok: true };
}

async function deleteAgentWorktrees(id: string): Promise<void> {
  if (!(await pathExists(AGENTS_DIR))) return;
  const sessions = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
  const repoDir = appRepoDir(id);
  await Promise.all(
    sessions
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const worktree = `${AGENTS_DIR}/${entry.name}/work/${id}`;
        if (!(await pathExists(worktree))) return;
        // Apps and workflows share the `work/<id>` namespace, so only remove a
        // checkout that actually originates from this app's repo and never a
        // same-slug workflow worktree (with its uncommitted changes).
        const origin = await worktreeOrigin(worktree);
        if (!origin || path.resolve(origin) !== path.resolve(repoDir)) return;
        await fs.rm(worktree, {
          recursive: true,
          force: true,
        });
      }),
  );
}
