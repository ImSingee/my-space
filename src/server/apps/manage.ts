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
  agentAppWorkDir,
  agentWorkDir,
  AGENTS_DIR,
  deploymentArtifactDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import { publishPlatformEvent } from '~server/platform-events';
import { buildMatchesDeployment } from './build-identity';
import { appDeployLock } from './deploy';
import { moveMasterToDeploymentTag, worktreeOrigin } from './git';
import {
  type NormalizedManifest,
  isValidAppId,
  isValidAppSlug,
} from './manifest';
import { dropAppDatabase } from './provision';
import {
  dropAppDataDatabase,
  withAppDataCutoverLock,
} from './data-table/provision';
import {
  recoverCurrentDataSchema,
  waitForDataMigrationBarrier,
} from './data-table/migrate';
import { closeDataRealtime } from './data-table/realtime';
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
  /** True when rolling back code would keep a newer/different Data Table schema. */
  dataSchemaMismatch: boolean;
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
  const liveDataSchemaHash = app?.dataSchemaHash ?? null;
  const dataActivationPending = Boolean(
    app?.dataActivationId &&
    (app.dataDbName || app.dataSchemaHash || app.capabilities?.dataTable),
  );
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
        dataSchemaMismatch:
          (dataActivationPending && !isCurrent) ||
          (Boolean(d.dataSchemaHash || liveDataSchemaHash) &&
            (d.dataSchemaHash ?? null) !== liveDataSchemaHash),
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
export function setAppArchived(
  id: string,
  archived: boolean,
): Promise<{ status: schema.AppStatus }> {
  // Match deploy/rollback/delete lock ordering. An archive requested during a
  // build queues behind that release and is then the deterministic last writer
  // instead of being overwritten by the release transaction.
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => setAppArchivedInner(id, archived)),
  );
}

async function setAppArchivedInner(
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

  if (archived) {
    stopApp(id);
    if (app.dataDbName || app.dataActivationId || app.capabilities?.dataTable) {
      await closeDataRealtime(id);
      // A Data request may already hold the shared migration lock after checking
      // the previous live status. Drain it before reporting archive complete, so
      // no mutation can commit after the user sees the App as archived.
      await waitForDataMigrationBarrier(id);
    }
  }
  // Archived apps must not keep firing cron; restored ones resume.
  await reloadScheduler();
  return { status };
}

/**
 * Change an app's mutable URL slug. The slug appears in the human-facing
 * `/app/<slug>` URL, so this is a cheap rename: no rebuild and no FK churn
 * (technical APIs and storage are keyed off the immutable `id`). Enforces shape
 * and uniqueness; the unique index on `slug` is the final backstop against
 * races.
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

  // Reject a slug that matches any other app's id OR slug: internal Agent
  // handles still accept either form and resolve ids first, so their namespace
  // must stay unambiguous even though human-facing routes use only slugs.
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
): Promise<{ version: number; dataSchemaMismatch: boolean }> {
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => rollbackAppInner(id, deploymentId)),
  );
}

async function rollbackAppInner(
  id: string,
  deploymentId: string,
): Promise<{ version: number; dataSchemaMismatch: boolean }> {
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
  if (!(await buildMatchesDeployment(id, deploymentId, snapshot))) {
    throw new Error(
      `The artifact for v${deployment.version} does not match its deployment.`,
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
  let latestDataSchemaHash = app.dataSchemaHash ?? null;
  // A pending activation may represent a migration whose COMMIT acknowledgement
  // was lost. Clear that fence only after taking the migration barrier and
  // reading the committed schema authoritatively. Code rollback stays available
  // when the Data DB is down, but Data access remains fenced until recovery.
  let dataMigrationResolved = !app.dataActivationId;
  if (app.dataDbName || app.dataActivationId) {
    try {
      latestDataSchemaHash = (await recoverCurrentDataSchema(id))?.hash ?? null;
      dataMigrationResolved = true;
    } catch {
      // Retain the last known hash. If an activation is pending, retaining its
      // fence is what prevents an unconfirmed schema from reaching restored code.
    }
  }
  const pendingActivationBackup =
    dataMigrationResolved && app.dataActivationId
      ? `${appBuildDir(id)}.bak-${app.dataActivationId}`
      : null;

  // Mutate the live build dir, Git master, and the app row under the same
  // advisory lock deploy holds for its version→tag→record step, so a concurrent
  // deploy on another process blocks until we finish (and vice versa).
  let previousDeploymentId = app.currentDeploymentId ?? null;
  await db.transaction(async (tx) => {
    await appDeployLock.acquire(tx, id);
    const current = await tx.query.apps.findFirst({
      where: (row, { eq: equal }) => equal(row.id, id),
      columns: { currentDeploymentId: true },
    });
    if (!current) throw new Error(`App "${id}" not found.`);
    previousDeploymentId = current.currentDeploymentId ?? null;
    const live = appBuildDir(id);
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(live, { recursive: true });
    // Legacy artifacts predate the immutable deployment marker. Always stamp
    // the live copy before changing the platform pointer so another worker can
    // distinguish rollback bytes from the still-current deployment while this
    // transaction is in flight.
    await fs.writeFile(
      path.join(live, 'deployment.json'),
      JSON.stringify({ deploymentId: deployment.id }, null, 2),
      'utf8',
    );
    await fs.cp(snapshot, live, { recursive: true });
    const sourceCommit = await moveMasterToDeploymentTag(id, sourceTag);
    if (pendingActivationBackup) {
      // The activation id is the durable key used to find this recovery state.
      // Remove the backup before the transaction clears that key so a crash can
      // never leave a snapshot that no later lifecycle operation can identify.
      await fs.rm(pendingActivationBackup, { recursive: true, force: true });
    }

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
        dataSchemaHash: latestDataSchemaHash,
        // Rollback is an explicit user-selected cutover. It may intentionally
        // restore code whose forward-only Data schema differs. Clear a failed
        // deployment's fence only after its migration outcome was resolved.
        dataActivationId: dataMigrationResolved ? null : app.dataActivationId,
        // Rollback must also bump the served userscript `@version`: Tampermonkey
        // only fetches when the remote version INCREASES, so re-serving the old
        // deployment's number (v3 → v2) would read as "older" and installed
        // scripts would never receive the rolled-back code.
        userscriptRevision: sql`${schema.apps.userscriptRevision} + 1`,
      })
      .where(eq(schema.apps.id, id));
  });

  if (previousDeploymentId !== deployment.id) {
    publishPlatformEvent({
      type: 'app.deployment.activated',
      appId: id,
      deploymentRevision: deployment.id,
    });
  }

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
      await ensureAppRunning(id, deployment.id);
    } catch {
      /* warm-start is best-effort; requests will retry the boot */
    }
  }
  // Reload schedules from the restored deployment's manifest.
  await reloadScheduler();
  return {
    version: deployment.version,
    dataSchemaMismatch:
      !dataMigrationResolved ||
      (Boolean(deployment.dataSchemaHash || latestDataSchemaHash) &&
        (deployment.dataSchemaHash ?? null) !== latestDataSchemaHash),
  };
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
): Promise<{ version: number; dataSchemaMismatch: boolean }> {
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq: e, and: a }) => a(e(d.appId, id), e(d.version, version)),
  });
  if (!deployment) {
    throw new Error(`App "${id}" has no deployment v${version}.`);
  }
  return rollbackApp(id, deployment.id);
}

/** Permanently delete an app: process, database, rows, and all artifacts. */
export function deleteApp(id: string): Promise<{ ok: true }> {
  // The id flows into `fs.rm(..., { force: true })` on several per-app dirs, so
  // reject anything that isn't a valid app slug before touching the filesystem.
  // Otherwise a crafted id like "../../src" (which matches no DB row) would
  // still resolve outside the app namespace and delete arbitrary directories.
  if (!isValidAppId(id)) {
    throw new Error(`Invalid app id: ${id}`);
  }
  // Match deploy/rollback lock ordering. The cross-process cutover lock keeps a
  // migration from provisioning or mutating the Data DB while deletion drains
  // readers and drops it; the process lock also serializes local filesystem work.
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => deleteAppInner(id)),
  );
}

async function deleteAppInner(id: string): Promise<{ ok: true }> {
  const app = await db.query.apps.findFirst({
    where: (row, { eq: equal }) => equal(row.id, id),
    columns: {
      capabilities: true,
      dataDbName: true,
      dataSchemaHash: true,
      dataActivationId: true,
    },
  });
  const hasManagedData = Boolean(
    app?.dataDbName ||
    app?.dataSchemaHash ||
    app?.dataActivationId ||
    app?.capabilities?.dataTable,
  );

  // Fail closed before draining Data transactions. New requests now reject on
  // platform state while an exclusive migration barrier waits for requests that
  // had already passed their guard.
  await db
    .update(schema.apps)
    .set({ status: 'archived' })
    .where(eq(schema.apps.id, id));
  stopApp(id);
  if (hasManagedData) {
    await closeDataRealtime(id);
    await waitForDataMigrationBarrier(id);

    // Data DB ownership is derived from the reusable App id. Do not delete the
    // platform row when cleanup fails: losing that ownership record would let a
    // future App with the same id inherit an orphaned database and its rows.
    await dropAppDataDatabase(id);
  }

  // Drop the legacy raw-SQL App database best-effort, preserving its established
  // lifecycle behavior. Managed Data cleanup above is the strict boundary.
  try {
    await dropAppDatabase(id);
  } catch {
    /* best-effort */
  }
  const { broadcastEntityWorkspaceCleanup } =
    await import('../agent-runner/hub');
  // Cascades to deployments, dashboard widgets, and sidebar items.
  const [deleted] = await db
    .delete(schema.apps)
    .where(eq(schema.apps.id, id))
    .returning({ createdAt: schema.apps.createdAt });
  if (deleted) {
    broadcastEntityWorkspaceCleanup('app', id, deleted.createdAt.toISOString());
  }

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
        const candidates = [
          agentAppWorkDir(entry.name, id),
          // Compatibility cleanup only. Old root-level worktrees are never
          // scanned or migrated during normal source operations.
          path.resolve(agentWorkDir(entry.name), id),
        ];
        await Promise.all(
          candidates.map(async (worktree) => {
            if (!(await pathExists(worktree))) return;
            const origin = await worktreeOrigin(worktree);
            if (!origin || path.resolve(origin) !== path.resolve(repoDir))
              return;
            await fs.rm(worktree, { recursive: true, force: true });
          }),
        );
      }),
  );
}
