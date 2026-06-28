/** Server-only: build + record a deployment and flip the app live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  BUILD_WORK_DIR,
  WORKSPACE_ROOT,
  appBuildDir,
  deploymentArtifactDir,
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

export async function deployApp(
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

    // The build passed, so this release earns the next version number. Compute
    // it before tagging so the Git tag (deploy/v<version>) and the deployment
    // row share the same version. Versions are derived from successful releases
    // only, so a failed attempt neither records a row nor keeps its tag.
    const last = await db.query.deployments.findFirst({
      where: (d, { eq: e }) => e(d.appId, id),
      orderBy: (d, { desc }) => [desc(d.version)],
    });
    const version = (last?.version ?? 0) + 1;

    const published = await publishDeploymentSource(id, sourceDir, version);
    publishedTag = published.tag;

    const live = appBuildDir(id);
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(live, { recursive: true });
    await fs.cp(tempBuild, live, { recursive: true });

    // Built, published, and live — only now record the release.
    await db.insert(schema.deployments).values({
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

    await db
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

    // Pick up cron schedule changes from the new deployment.
    await reloadScheduler();

    return {
      deploymentId,
      version,
      normalized: build.normalized,
      log: build.log,
    };
  } catch (error) {
    // The deploy failed before any release was recorded, so history stays clean.
    // If we already created the version tag, remove it so a failed attempt
    // leaves no Git trace (the next attempt reuses this version number).
    if (publishedTag) {
      await deleteDeploymentTag(id, publishedTag).catch(() => {});
    }
    // Restore the app's status: an archived app must stay archived (a failed
    // redeploy must not silently re-enable it), one that already has a live
    // deployment keeps serving it, and a never-deployed app is marked failed.
    await db
      .update(schema.apps)
      .set({
        status:
          app.status === 'archived'
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
