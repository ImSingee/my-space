/** Server-only: build + record a deployment and flip the subapp live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import { deploymentBuildDir, subappBuildDir } from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { buildSubapp } from './build';
import type { NormalizedManifest } from './manifest';
import { ensureSubappDatabase, subappDbName } from './provision';
import { ensureSubappRunning, setKeepAlive, stopSubapp } from './runtime';
import { reloadScheduler } from './scheduler';

export type DeployResult = {
  deploymentId: string;
  version: number;
  normalized: NormalizedManifest;
  log: string;
};

export async function deploySubapp(id: string): Promise<DeployResult> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!subapp) {
    throw new Error(`Subapp "${id}" not found.`);
  }

  await db
    .update(schema.subapps)
    .set({ status: 'building' })
    .where(eq(schema.subapps.id, id));

  let build;
  try {
    build = await buildSubapp(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.subapps)
      .set({ status: 'failed' })
      .where(eq(schema.subapps.id, id));
    await db.insert(schema.deployments).values({
      subappId: id,
      status: 'failed',
      error: message,
      buildLog: message,
    });
    throw error;
  }

  let dbName = subapp.dbName ?? null;
  if (build.source.capabilities.database) {
    await ensureSubappDatabase(id);
    dbName = subappDbName(id);
  }

  let webhookSecret = subapp.webhookSecret ?? null;
  if (build.source.capabilities.webhook && !webhookSecret) {
    webhookSecret = randomUUID().replaceAll('-', '');
  }

  const last = await db.query.deployments.findFirst({
    where: (d, { eq: e }) => e(d.subappId, id),
    orderBy: (d, { desc }) => [desc(d.version)],
  });
  const version = (last?.version ?? 0) + 1;

  const [deployment] = await db
    .insert(schema.deployments)
    .values({
      subappId: id,
      version,
      status: 'deployed',
      manifestNormalized: build.normalized as unknown as JsonObject,
      buildLog: build.log,
    })
    .returning();

  // Snapshot the freshly built artifacts so we can roll back to this exact
  // deployment later without rebuilding from (possibly mutated) source.
  try {
    const snapshot = deploymentBuildDir(id, deployment.id);
    await fs.rm(snapshot, { recursive: true, force: true });
    await fs.mkdir(snapshot, { recursive: true });
    await fs.cp(subappBuildDir(id), snapshot, { recursive: true });
  } catch {
    /* snapshot is best-effort; live deploy already succeeded */
  }

  await db
    .update(schema.subapps)
    .set({
      status: 'deployed',
      name: build.source.name,
      description: build.source.description || null,
      capabilities: build.source.capabilities,
      backendMode: build.source.backendMode,
      manifest: build.source as unknown as JsonObject,
      dbName,
      webhookSecret,
      currentDeploymentId: deployment.id,
    })
    .where(eq(schema.subapps.id, id));

  // Drop the old backend process so the next request boots the new build.
  const longRunning =
    build.source.backendMode === 'long-running' &&
    build.source.capabilities.backend;
  stopSubapp(id);
  if (longRunning) {
    // Warm-start and keep the backend alive instead of lazy booting per request.
    setKeepAlive(id, true);
    try {
      await ensureSubappRunning(id);
    } catch {
      /* warm-start is best-effort; requests will retry the boot */
    }
  }

  // Pick up cron schedule changes from the new deployment.
  await reloadScheduler();

  return {
    deploymentId: deployment.id,
    version,
    normalized: build.normalized,
    log: build.log,
  };
}
