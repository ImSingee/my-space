/** Server-only: build + record a deployment and flip the app live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  BUILD_WORK_DIR,
  WORKSPACE_ROOT,
  appBuildDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { buildApp } from './build';
import {
  assertDeployableWorktree,
  deleteDeploymentTag,
  prepareDeployCheckout,
  publishDeploymentSource,
} from './git';
import type { NormalizedManifest } from './manifest';
import { ensureAppDatabase, appDbName } from './provision';
import { ensureAppRunning, setKeepAlive, stopApp } from './runtime';
import { reloadScheduler } from './scheduler';

export type DeployResult = {
  deploymentId: string;
  version: number;
  normalized: NormalizedManifest;
  log: string;
};

export type DeployAppOptions = {
  sourceDir?: string;
  /** Required release note recorded on the deployment (e.g. what changed). */
  message: string;
};

function workspaceRelative(p: string): string {
  return path.relative(WORKSPACE_ROOT, p).split(path.sep).join('/');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo a half-applied live swap when a deploy fails after touching the live dir.
 *
 * Runs under the per-app deploy advisory lock and only acts while
 * `currentDeploymentId` still equals the deployment we're restoring to:
 * otherwise a concurrent successful deploy on another process may have already
 * become current and swapped live, and restoring here would clobber its newer
 * build while the DB points at it.
 *
 * Restores the exact previous build from `liveBackup` when present; for a
 * never-deployed app (no previous build) it clears the unrecorded swap. It never
 * deletes the live dir without first confirming a restore source exists, so a
 * pruned snapshot can't turn a failed deploy into an outage.
 */
async function restoreLiveBuild(
  id: string,
  deploymentId: string | null,
  liveBackup: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${APP_DEPLOY_LOCK_NS}, hashtext(${id}))`,
    );
    const current = await tx.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: { currentDeploymentId: true },
    });
    if ((current?.currentDeploymentId ?? null) !== deploymentId) {
      // A newer deploy already became current and owns the live dir; just drop
      // our stale backup.
      await fs.rm(liveBackup, { recursive: true, force: true }).catch(() => {});
      return;
    }
    const live = appBuildDir(id);
    if (await pathExists(liveBackup)) {
      // Put the exact previous build back.
      await fs.rm(live, { recursive: true, force: true });
      await fs.rename(liveBackup, live);
      return;
    }
    // No backup means there was no previous build (first deploy): nothing is
    // recorded to serve, so clear the unrecorded swap.
    if (!deploymentId) {
      await fs.rm(live, { recursive: true, force: true });
      return;
    }
    // A previous deployment is recorded but its backup is gone (e.g. a crash
    // between deploys removed it): fall back to its immutable snapshot, resolved
    // the same way rollback/download do. Only swap once we know the source
    // exists — never leave the app with nothing to serve.
    const artifact = deploymentArtifactDir(id, deploymentId);
    const snapshot = (await pathExists(artifact))
      ? artifact
      : deploymentBuildDir(id, deploymentId);
    if (!(await pathExists(snapshot))) return;
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(live, { recursive: true });
    await fs.cp(snapshot, live, { recursive: true });
  });
}

// Advisory-lock namespace for app deploys (distinct from workflows) so version
// allocation is serialized across server processes, not just within one.
const APP_DEPLOY_LOCK_NS = 1;

const appDeployChains = new Map<string, Promise<unknown>>();

/** Run `fn` only after any in-flight deploy for the same app id has settled. */
function withAppDeployLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = appDeployChains.get(id) ?? Promise.resolve();
  // Chain regardless of the previous deploy's outcome — a failed deploy must not
  // wedge later attempts for the same app.
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  appDeployChains.set(id, tail);
  void tail.finally(() => {
    if (appDeployChains.get(id) === tail) appDeployChains.delete(id);
  });
  return run;
}

/**
 * Build + record a deployment and flip the app live. Serialized per app so two
 * concurrent deploys can't both read the same latest version, assign the same
 * next version, and force-move the same `deploy/v<n>` tag onto different commits.
 */
export function deployApp(
  id: string,
  options: DeployAppOptions,
): Promise<DeployResult> {
  return withAppDeployLock(id, () => deployAppInner(id, options));
}

async function deployAppInner(
  id: string,
  options: DeployAppOptions,
): Promise<DeployResult> {
  const message = options.message?.trim();
  if (!message) {
    throw new Error('A deployment message is required.');
  }

  const app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!app) {
    throw new Error(`App "${id}" not found.`);
  }

  const sourceDir = options.sourceDir ?? (await prepareDeployCheckout(id));
  await assertDeployableWorktree(id, sourceDir);

  // A deployment row records a *successful* release, so we don't write one until
  // the build passes — a failed attempt leaves no history entry and burns no
  // version number. We still mint a stable id up front to key the build/artifact
  // dirs and the deployment row.
  const deploymentId = ulid().toLowerCase();
  const tempBuild = path.join(BUILD_WORK_DIR, id, deploymentId, 'out');
  // Tracked so a failure after tagging can remove the tag (keeps Git history
  // free of failed attempts, mirroring the deployments table).
  let publishedTag: string | undefined;
  // Once the deployment row exists it references `publishedTag` as its
  // sourceTag, so a later failure must NOT delete that tag (rollback needs it).
  let recorded = false;
  // The deployment this app currently serves; used to restore the live build if
  // the swap runs but the release isn't recorded (e.g. a COMMIT failure).
  const prevDeploymentId = app.currentDeploymentId ?? null;
  // The previous live build is moved here (cheap same-dir rename) before the
  // swap so a failed COMMIT can restore the exact prior bits without depending
  // on artifact retention.
  const liveBackup = `${appBuildDir(id)}.bak-${deploymentId}`;
  // Set right before the live dir is mutated so the catch can tell an
  // unrecorded-but-swapped state from one where the live dir was never touched.
  let liveTouched = false;

  try {
    await db
      .update(schema.apps)
      .set({ status: 'building' })
      .where(eq(schema.apps.id, id));

    const build = await buildApp(id, { sourceDir, outputDir: tempBuild });
    let dbName = app.dbName ?? null;
    if (build.source.capabilities.database) {
      await ensureAppDatabase(id);
      dbName = appDbName(id);
    }

    let webhookSecret = app.webhookSecret ?? null;
    if (build.source.capabilities.webhook && !webhookSecret) {
      webhookSecret = randomUUID().replaceAll('-', '');
    }

    const artifact = deploymentArtifactDir(id, deploymentId);
    await fs.rm(artifact, { recursive: true, force: true });
    await fs.mkdir(artifact, { recursive: true });
    await fs.cp(tempBuild, artifact, { recursive: true });

    // The build passed, so this release earns the next version number. The
    // version → tag → record critical section runs under a per-app advisory lock
    // (held for the transaction) so concurrent deploys on different processes
    // can't both allocate the same version and force-move deploy/v<n> onto
    // different commits; the loser blocks here, then sees the winner's row and
    // takes the next number. Versions derive from successful releases only.
    let version = 0;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${APP_DEPLOY_LOCK_NS}, hashtext(${id}))`,
      );
      const last = await tx.query.deployments.findFirst({
        where: (d, { eq: e }) => e(d.appId, id),
        orderBy: (d, { desc }) => [desc(d.version)],
      });
      version = (last?.version ?? 0) + 1;

      const published = await publishDeploymentSource(id, sourceDir, version);
      publishedTag = published.tag;

      // Record the release first, then swap the live build dir as the LAST step
      // in the transaction. Ordering the filesystem swap after the row writes
      // means a failing insert/update never touches the live dir, and the only
      // window where live could change without the row committing is a COMMIT
      // failure — handled by the `liveTouched` restore in the catch below.
      await tx.insert(schema.deployments).values({
        id: deploymentId,
        appId: id,
        version,
        status: 'deployed',
        message,
        manifestNormalized: build.normalized as unknown as JsonObject,
        sourceCommit: published.commit,
        sourceTag: published.tag,
        artifactPath: workspaceRelative(artifact),
        buildLog: build.log,
      });

      await tx
        .update(schema.apps)
        .set({
          status: 'deployed',
          name: build.source.name,
          description: build.source.description || null,
          capabilities: build.source.capabilities,
          backendMode: build.source.backendMode,
          manifest: build.source as unknown as JsonObject,
          repoPath: published.repoPath,
          currentSourceCommit: published.commit,
          dbName,
          webhookSecret,
          currentDeploymentId: deploymentId,
        })
        .where(eq(schema.apps.id, id));

      // Live swap is the last statement so an insert/update failure leaves the
      // previous build serving untouched. `liveTouched` arms the catch's restore
      // for the remaining window (a swap done, then COMMIT fails).
      liveTouched = true;
      const live = appBuildDir(id);
      await fs.rm(liveBackup, { recursive: true, force: true });
      // Move the old build aside instead of deleting it so the catch can put it
      // back verbatim if this transaction never commits.
      if (await pathExists(live)) {
        await fs.rename(live, liveBackup);
      }
      await fs.mkdir(live, { recursive: true });
      await fs.cp(tempBuild, live, { recursive: true });
    });
    // Set only after the tx commits: a rollback after the insert would otherwise
    // leave `recorded` true with no row, stranding the force-moved tag.
    recorded = true;
    // The release is committed and live; the old build's backup is no longer
    // needed.
    await fs.rm(liveBackup, { recursive: true, force: true }).catch(() => {});

    // Drop the old backend process so the next request boots the new build.
    const longRunning =
      build.source.backendMode === 'long-running' &&
      build.source.capabilities.backend;
    stopApp(id);
    if (longRunning) {
      // Warm-start and keep the backend alive instead of lazy booting per request.
      setKeepAlive(id, true);
      try {
        await ensureAppRunning(id);
      } catch {
        /* warm-start is best-effort; requests will retry the boot */
      }
    }

    // Pick up cron schedule changes from the new deployment. This is best-effort
    // post-commit work: the release is already recorded and live, so a reload
    // failure must neither fail the deploy nor trip the cleanup path below (which
    // would delete this recorded deployment's source tag).
    await reloadScheduler().catch(() => {});

    return {
      deploymentId,
      version,
      normalized: build.normalized,
      log: build.log,
    };
  } catch (error) {
    // Only remove the version tag for a release that was never recorded — once a
    // deployment row exists it references this tag, so deleting it would strand
    // that row's sourceTag and break rollback to this version. We re-check
    // ownership and delete UNDER the per-app advisory lock: otherwise a concurrent
    // deploy could be mid-critical-section (its deploy/v<n> tag force-moved but its
    // row not yet committed) and we'd see "no owner" and delete the tag its
    // successful release will reference. Holding the lock serializes us with that
    // deploy, so we only ever delete a genuinely orphaned tag.
    if (publishedTag && !recorded) {
      const tag = publishedTag;
      await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${APP_DEPLOY_LOCK_NS}, hashtext(${id}))`,
          );
          const owner = await tx.query.deployments.findFirst({
            where: (d, { eq: e, and: a }) =>
              a(e(d.appId, id), e(d.sourceTag, tag)),
          });
          if (!owner) {
            await deleteDeploymentTag(id, tag).catch(() => {});
          }
        })
        .catch(() => {});
    }
    // If the live dir was swapped but the release wasn't recorded (only a COMMIT
    // failure can reach here), the app would otherwise serve unrecorded files
    // while the DB still points at the previous deployment. Put the previous
    // build back so the filesystem and DB agree.
    if (liveTouched && !recorded) {
      await restoreLiveBuild(id, prevDeploymentId, liveBackup).catch(() => {});
    }
    // Restore the app's status: a recorded release stays deployed; otherwise an
    // archived app stays archived (a failed redeploy must not re-enable it), one
    // with a live deployment keeps serving it, and a never-deployed app fails.
    await db
      .update(schema.apps)
      .set({
        status: recorded
          ? 'deployed'
          : app.status === 'archived'
            ? 'archived'
            : app.currentDeploymentId
              ? 'deployed'
              : 'failed',
      })
      .where(eq(schema.apps.id, id));
    throw error;
  } finally {
    await fs.rm(path.dirname(tempBuild), { recursive: true, force: true });
  }
}
