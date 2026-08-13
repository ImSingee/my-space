/** Server-only: build + record a deployment and flip the app live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  BUILD_WORK_DIR,
  appBuildDir,
  deploymentArtifactDir,
  deploymentBuildDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { createDeployLock, workspaceRelative } from '~server/deploy-lock';
import { buildApp, type BuildResult } from './build';
import {
  buildMatchesDeployment,
  liveBuildMatchesDeployment,
} from './build-identity';
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
import {
  applyDataMigration,
  DataMigrationOutcomeUnknown,
  recoverCurrentDataSchema,
} from './data-table/migrate';
import { appDataDbName, withAppDataCutoverLock } from './data-table/provision';

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
  /** Explicit acknowledgement required for destructive Data Table migrations. */
  allowDestructiveDataMigration?: boolean;
  /** Fingerprint returned by the exact destructive migration preview. */
  dataMigrationApprovalToken?: string;
};

async function warmCommittedBackend(
  id: string,
  deploymentId: string,
  longRunning: boolean,
): Promise<void> {
  if (!longRunning) return;
  setKeepAlive(id, true);
  try {
    await ensureAppRunning(id, deploymentId);
  } catch {
    /* warm-start is best-effort; requests will retry the boot */
  }
}

/** Complete process-local post-commit activation work idempotently. */
async function finishCommittedRelease(
  id: string,
  liveBackup: string,
  deploymentId: string,
  longRunning: boolean,
): Promise<void> {
  // The activation id is the only durable key for this sibling backup. Keep
  // the fence when cleanup fails so reconciliation can retry the exact path.
  await fs.rm(liveBackup, { recursive: true, force: true });

  // Stop the old backend before clearing the fence, so no stale process can
  // enter the newly migrated Data schema once access reopens.
  stopApp(id);

  // Keep the durable activation fence through COMMIT and stale-runtime
  // shutdown. If the acknowledgement or this update loses its connection, both
  // committed and rolled-back outcomes retain the same exact deployment id for
  // startup/the next lifecycle operation to reconcile.
  const finalized = await db
    .update(schema.apps)
    .set({ dataActivationId: null })
    .where(
      and(
        eq(schema.apps.id, id),
        eq(schema.apps.currentDeploymentId, deploymentId),
        eq(schema.apps.dataActivationId, deploymentId),
      ),
    )
    .returning({ id: schema.apps.id });
  if (finalized.length === 0) {
    const current = await db.query.apps.findFirst({
      where: (row, { eq: equal }) => equal(row.id, id),
      columns: { currentDeploymentId: true, dataActivationId: true },
    });
    if (
      current?.currentDeploymentId !== deploymentId ||
      current.dataActivationId !== null
    ) {
      throw new Error(
        `Deployment ${deploymentId} committed, but its activation fence ` +
          'could not be finalized.',
      );
    }
  }

  // Apply the committed manifest's runtime mode only after Data access is open:
  // a backend may read Data during its own startup. `ensureAppRunning` re-reads
  // status/deployment/capabilities, so a later archive still wins. Avoid an
  // extra best-effort manifest read here; a transient failure must not lose the
  // long-running keep-alive contract until the next platform restart.
  await warmCommittedBackend(id, deploymentId, longRunning);

  await reloadScheduler().catch(() => {});
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Install an immutable deployment snapshot into the mutable live directory. */
async function installDeploymentBuild(
  id: string,
  deploymentId: string,
): Promise<boolean> {
  const artifact = deploymentArtifactDir(id, deploymentId);
  const snapshot = (await pathExists(artifact))
    ? artifact
    : deploymentBuildDir(id, deploymentId);
  if (!(await pathExists(snapshot))) return false;
  if (!(await buildMatchesDeployment(id, deploymentId, snapshot))) return false;

  const live = appBuildDir(id);
  const staged = `${live}.recover-${randomUUID()}`;
  try {
    await fs.rm(staged, { recursive: true, force: true });
    await fs.mkdir(staged, { recursive: true });
    await fs.cp(snapshot, staged, { recursive: true });
    await fs.writeFile(
      path.join(staged, 'deployment.json'),
      JSON.stringify({ deploymentId }, null, 2),
      'utf8',
    );
    await fs.rm(live, { recursive: true, force: true });
    await fs.rename(staged, live);
    return true;
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
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
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await appDeployLock.acquire(tx, id);
    const current = await tx.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: { currentDeploymentId: true },
    });
    if ((current?.currentDeploymentId ?? null) !== deploymentId) {
      // A newer deploy already became current and owns the live dir; just drop
      // our stale backup.
      await fs.rm(liveBackup, { recursive: true, force: true });
      return true;
    }
    const live = appBuildDir(id);
    // A first deployment has no valid previous live build. Never restore an
    // unrelated/stale backup merely because one happens to exist on disk.
    if (!deploymentId) {
      await fs.rm(live, { recursive: true, force: true });
      await fs.rm(liveBackup, { recursive: true, force: true });
      return true;
    }
    if (
      (await pathExists(liveBackup)) &&
      (await buildMatchesDeployment(id, deploymentId, liveBackup))
    ) {
      // Put the exact previous build back.
      await fs.rm(live, { recursive: true, force: true });
      await fs.rename(liveBackup, live);
      return true;
    }
    // A previous deployment is recorded but its backup is gone (e.g. a crash
    // between deploys removed it), or its marker does not match the platform
    // pointer: fall back to the immutable snapshot. This marker check prevents
    // a retry from restoring an earlier unrecorded deployment as if it were the
    // current one.
    const restored = await installDeploymentBuild(id, deploymentId);
    if (restored) {
      await fs.rm(liveBackup, { recursive: true, force: true });
    }
    return restored;
  });
}

/**
 * Deploy serialization for apps (advisory-lock namespace 1, distinct from
 * workflows). Rollback (manage.ts) shares this lock so its artifact/Git/row
 * mutations can't interleave with a concurrent deploy's.
 */
export const appDeployLock = createDeployLock(1);

/**
 * Reconcile a durable activation fence left by a crash or an unavailable
 * COMMIT acknowledgement. The caller must hold the per-App cutover lock.
 */
async function reconcilePendingActivation(id: string): Promise<string | null> {
  const state = await db.transaction(async (tx) => {
    // Wait for a release transaction whose client disappeared while PostgreSQL
    // was still resolving COMMIT, then inspect its exact deployment id.
    await appDeployLock.acquire(tx, id);
    const app = await tx.query.apps.findFirst({
      where: (row, { eq: equal }) => equal(row.id, id),
      columns: {
        status: true,
        currentDeploymentId: true,
        capabilities: true,
        backendMode: true,
        dataSchemaHash: true,
        dataActivationId: true,
      },
    });
    if (!app?.dataActivationId) return null;
    const pendingId = app.dataActivationId;
    const pendingDeployment = await tx.query.deployments.findFirst({
      where: (row, { and: all, eq: equal }) =>
        all(equal(row.id, pendingId), equal(row.appId, id)),
      columns: { id: true },
    });
    const currentDeployment = app.currentDeploymentId
      ? await tx.query.deployments.findFirst({
          where: (row, { and: all, eq: equal }) =>
            all(
              equal(row.id, app.currentDeploymentId as string),
              equal(row.appId, id),
            ),
          columns: { id: true, dataSchemaHash: true },
        })
      : null;
    return { app, pendingId, pendingDeployment, currentDeployment };
  });
  if (!state) return null;

  const { app, pendingId, pendingDeployment, currentDeployment } = state;
  const backup = `${appBuildDir(id)}.bak-${pendingId}`;
  if (pendingDeployment) {
    if (app.currentDeploymentId !== pendingId) {
      // The pending release committed, then the user explicitly restored a
      // different code deployment while the Data DB was unavailable. That
      // rollback intentionally keeps the activation fence until the migration
      // outcome can be read. Treat this as a recoverable forward-only schema
      // mismatch, not as permanent platform corruption.
      const currentId = app.currentDeploymentId;
      if (!currentId || !currentDeployment) {
        throw new Error(
          `Pending deployment ${pendingId} was recorded, but the current ` +
            'deployment cannot be recovered.',
        );
      }
      if (!(await liveBuildMatchesDeployment(id, currentId))) {
        const installed = await installDeploymentBuild(id, currentId);
        if (!installed) {
          throw new Error(
            `App "${id}" was restored to deployment ${currentId}, but its ` +
              'build artifact is unavailable for activation recovery.',
          );
        }
      }

      // Always cross the migration barrier here. The restored deployment may
      // disable Data Tables even though the pending release created or changed
      // the managed database, and its authoritative hash must not be lost.
      const recovered = await recoverCurrentDataSchema(id);
      const restoreLongRunning =
        app.status !== 'archived' &&
        app.backendMode === 'long-running' &&
        Boolean(app.capabilities?.backend);
      stopApp(id);
      try {
        // The pending id is the only durable key for this backup. Delete it
        // before clearing that id so a failed cleanup remains retryable.
        await fs.rm(backup, { recursive: true, force: true });
        const finalized = await db
          .update(schema.apps)
          .set({
            dataActivationId: null,
            dataSchemaHash: recovered?.hash ?? null,
            status: app.status === 'building' ? 'deployed' : app.status,
          })
          .where(
            and(
              eq(schema.apps.id, id),
              eq(schema.apps.currentDeploymentId, currentId),
              eq(schema.apps.dataActivationId, pendingId),
            ),
          )
          .returning({ id: schema.apps.id });
        if (finalized.length === 0) {
          throw new Error(
            `App "${id}" changed while its restored Data Table activation was ` +
              'being finalized.',
          );
        }
      } catch (error) {
        // The fence is still closed, so restoring this known-current backend is
        // safe. Do not let a transient platform DB failure turn an explicit
        // rollback into a long-running backend outage.
        await warmCommittedBackend(id, currentId, restoreLongRunning);
        throw error;
      }
      // stopApp intentionally clears keep-alive. Re-arm and boot the restored
      // deployment before returning to the new deploy attempt: checkout/build
      // can fail later, but the authoritative rollback must remain available.
      await warmCommittedBackend(id, currentId, restoreLongRunning);
      return null;
    }
    if (!(await liveBuildMatchesDeployment(id, pendingId))) {
      const installed = await installDeploymentBuild(id, pendingId);
      if (!installed) {
        throw new Error(
          `Pending deployment ${pendingId} committed, but its build artifact ` +
            'is unavailable for activation recovery.',
        );
      }
    }
    await finishCommittedRelease(
      id,
      backup,
      pendingId,
      app.status !== 'archived' &&
        app.backendMode === 'long-running' &&
        Boolean(app.capabilities?.backend),
    );
    return null;
  }

  if (app.currentDeploymentId === pendingId) {
    throw new Error(
      `App "${id}" points at missing pending deployment ${pendingId}.`,
    );
  }
  const restored = await restoreLiveBuild(
    id,
    app.currentDeploymentId ?? null,
    backup,
  ).catch(() => false);
  if (!restored) {
    throw new Error(
      `Could not restore App "${id}" after deployment ${pendingId} rolled back. ` +
        'The activation fence and recovery artifacts were retained.',
    );
  }

  // A rolled-back platform release may still have committed its forward-only
  // Data migration. Clear the fence only when the active code's recorded schema
  // matches the authoritative Data DB state (or the active app has no Data API).
  let dataMatchesCurrent = !app.capabilities?.dataTable;
  let recoveredDataHash = app.dataSchemaHash ?? null;
  if (app.capabilities?.dataTable) {
    try {
      const recovered = await recoverCurrentDataSchema(id);
      recoveredDataHash = recovered?.hash ?? null;
      dataMatchesCurrent = app.currentDeploymentId
        ? Boolean(
            currentDeployment &&
            (currentDeployment.dataSchemaHash ?? null) === recoveredDataHash,
          )
        : true;
    } catch {
      // The restored code is safe to serve, but Data remains fenced until a
      // later deploy or explicit rollback can read the migration barrier.
    }
  }
  if (!dataMatchesCurrent) return pendingId;

  // This failed release has no deployment row. Once the fence is gone, no
  // durable state can identify its staged artifact for a later retry.
  await fs.rm(deploymentArtifactDir(id, pendingId), {
    recursive: true,
    force: true,
  });
  await db
    .update(schema.apps)
    .set({
      dataActivationId: null,
      dataSchemaHash: recoveredDataHash,
      status:
        app.status === 'building'
          ? app.currentDeploymentId
            ? 'deployed'
            : 'failed'
          : app.status,
    })
    .where(
      and(eq(schema.apps.id, id), eq(schema.apps.dataActivationId, pendingId)),
    );
  return null;
}

/** Best-effort crash recovery run once during platform startup. */
export async function reconcilePendingAppActivations(): Promise<void> {
  const pending = await db.query.apps.findMany({
    where: (row, { isNotNull }) => isNotNull(row.dataActivationId),
    columns: { id: true },
  });
  for (const app of pending) {
    await appDeployLock
      .withLock(app.id, () =>
        withAppDataCutoverLock(app.id, () =>
          reconcilePendingActivation(app.id),
        ),
      )
      .catch((error) => {
        console.error(
          `[apps] activation recovery failed for ${app.id}:`,
          error,
        );
      });
  }
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
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => deployAppInner(id, options)),
  );
}

async function deployAppInner(
  id: string,
  options: DeployAppOptions,
): Promise<DeployResult> {
  const message = options.message?.trim();
  if (!message) {
    throw new Error('A deployment message is required.');
  }

  // A previous process may have died after swapping live bytes or while
  // PostgreSQL acknowledged COMMIT. Resolve that exact activation before using
  // the mutable live directory as this attempt's rollback source.
  const supersededPendingId = await reconcilePendingActivation(id);

  let app = await db.query.apps.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!app) {
    throw new Error(`App "${id}" not found.`);
  }
  // `status` is temporarily changed for build visibility. Keep the status that
  // existed before this deploy so a later failure cannot unarchive the app.
  let statusBeforeBuild = app.status;

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
  let prevDeploymentId = app.currentDeploymentId ?? null;
  // The previous live build is moved here (cheap same-dir rename) before the
  // swap so a failed COMMIT can restore the exact prior bits without depending
  // on artifact retention.
  const liveBackup = `${appBuildDir(id)}.bak-${deploymentId}`;
  // Set right before the live dir is mutated so the catch can tell an
  // unrecorded-but-swapped state from one where the live dir was never touched.
  let liveTouched = false;
  // Set only after the release transaction callback has completed every DB,
  // Git, and filesystem step. A rejection before this point is a definite
  // rollback; a rejection afterwards can be an ambiguous COMMIT acknowledgement.
  let releaseCallbackCompleted = false;
  // A committed Data migration cannot be rolled back. The durable activation
  // fence remains set after a later release failure so the old code cannot call
  // the newer schema; a retry or explicit rollback owns the recovery cutover.
  let dataFenceClaimed = false;
  let keepDataFenceOnFailure = Boolean(app.dataActivationId);
  let build: BuildResult | undefined;
  let version = 0;

  try {
    await db
      .update(schema.apps)
      // An archived app must remain unavailable throughout its build. A
      // successful activation below deliberately promotes it to deployed.
      .set({
        status: statusBeforeBuild === 'archived' ? 'archived' : 'building',
      })
      .where(eq(schema.apps.id, id));

    build = await buildApp(id, {
      sourceDir,
      outputDir: tempBuild,
      deploymentId,
    });

    // Validate declared outbound workflow calls before recording the release:
    // each must reference a top-level workflow that is currently callable
    // (deployed with its webhook trigger enabled) so the runtime injection
    // actually works. The secret is injected into a *running* backend's env, so
    // a declaration needs both the backend capability AND a staged backend
    // entry — otherwise the build stages no process to receive HATCH_WORKFLOWS
    // and the calls can never fire.
    if (
      build.source.workflows.length > 0 &&
      (!build.source.capabilities.backend || !build.source.backend)
    ) {
      throw new Error(
        'Workflow calls require a backend: set capabilities.backend and ' +
          'define backend.entry.',
      );
    }
    if (build.normalized.workflows && build.normalized.workflows.length > 0) {
      const { getCallableWorkflow } = await import('../workflows/external');
      for (const ref of build.normalized.workflows) {
        const callable = await getCallableWorkflow(ref.workflow);
        if (!callable) {
          throw new Error(
            `This app declares a call to workflow "${ref.workflow}" (alias ` +
              `"${ref.alias}"), but that workflow is not callable. Deploy the ` +
              'workflow with its webhook trigger enabled, then redeploy this app.',
          );
        }
      }
    }

    // Validate cron jobs that target an RPC method. The app must stage a backend
    // (capability AND a backend.entry) to receive the call, and the method must
    // exist in the deployed proto service AND be unary — `invokeCron()` always
    // sends a single unary Connect JSON request with an empty body. Without these
    // checks an unsupported target would record a successful deployment yet fail
    // only when the scheduler / "Run now" later invokes it. Legacy `path` jobs
    // need no API. (Jobs only run when the cron capability is on, so we validate
    // the effective normalized list.)
    const methodCronJobs = (build.normalized.cron ?? []).filter(
      (j) => j.method,
    );
    if (methodCronJobs.length > 0) {
      if (!build.source.capabilities.backend || !build.source.backend) {
        throw new Error(
          'Cron jobs that call an RPC method require a backend: set ' +
            'capabilities.backend and define backend.entry.',
        );
      }
      const service = build.normalized.rpc?.service;
      const methods = new Map(
        (build.normalized.api?.services ?? [])
          .filter((s) => !service || s.name === service)
          .flatMap((s) => s.methods)
          .map((m) => [m.name, m] as const),
      );
      for (const job of methodCronJobs) {
        const method = service ? methods.get(job.method as string) : undefined;
        if (!method) {
          throw new Error(
            `Cron job "${job.name}" targets RPC method "${job.method}", which ` +
              "is not defined in the app's proto service. Add the method to the " +
              'proto (and declare an rpc service), then redeploy.',
          );
        }
        if (method.clientStreaming || method.serverStreaming) {
          throw new Error(
            `Cron job "${job.name}" targets RPC method "${job.method}", which ` +
              'is a streaming method. Cron invokes a single unary request, so ' +
              'the target must be a unary RPC method.',
          );
        }
      }
    }

    // Inbound webhooks are forwarded to the backend's `/__webhook`, so the app
    // must stage a backend (capability AND entry) to receive them — otherwise
    // the deploy would succeed but every webhook call would fail at runtime with
    // no process to proxy to.
    if (
      build.source.capabilities.webhook &&
      (!build.source.capabilities.backend || !build.source.backend)
    ) {
      throw new Error(
        'Inbound webhooks require a backend: set capabilities.backend and ' +
          'define backend.entry (verified webhooks are forwarded to /__webhook).',
      );
    }

    let dbName = app.dbName ?? null;
    if (build.source.capabilities.database) {
      await ensureAppDatabase(id);
      dbName = appDbName(id);
    }
    let dataDbName = app.dataDbName ?? null;
    let dataSchemaHash = app.dataSchemaHash ?? null;
    let deploymentDataSchemaHash: string | null = null;

    // Webhook auth mode controls the shared secret: 'platform' mints + keeps a
    // per-app secret (the platform verifies it, then forwards an HMAC-signed
    // request). 'none' is an unauthenticated passthrough that never reads the
    // secret — but we deliberately RETAIN any existing one rather than null it,
    // so a later rollback to a platform-auth deployment still has its reusable
    // secret (rollback only flips the deployment pointer and never re-mints).
    // The secret is hidden from the UI/inspect while the live mode is 'none'.
    const webhookAuth = build.source.webhook?.auth ?? 'platform';
    let webhookSecret = app.webhookSecret ?? null;
    if (
      build.source.capabilities.webhook &&
      webhookAuth === 'platform' &&
      !webhookSecret
    ) {
      webhookSecret = randomUUID().replaceAll('-', '');
    }

    // Mint a per-app HMAC key the first time an app needs one. The platform
    // signs the requests it makes into the backend — cron RPC calls and
    // platform-auth webhook forwards — so the backend can verify they came from
    // the platform. Persisted and reused across deploys; never exposed to the
    // browser.
    const needsSigningKey =
      build.source.capabilities.backend ||
      (build.source.capabilities.webhook && webhookAuth === 'platform');
    let signingSecret = app.signingSecret ?? null;
    if (needsSigningKey && !signingSecret) {
      signingSecret = randomUUID().replaceAll('-', '');
    }

    // Mint the app-level userscript token the first time an app ships scripts.
    // It authorizes the public `.user.js` download/update route (no session), so
    // like the webhook secret we RETAIN any existing one across redeploys and
    // disable cycles — otherwise a redeploy would rotate the token baked into
    // every already-installed subscription and silently break auto-update.
    const shipsUserscripts =
      build.source.capabilities.userscripts &&
      build.source.userscripts.length > 0;
    let userscriptSecret = app.userscriptSecret ?? null;
    if (shipsUserscripts && !userscriptSecret) {
      userscriptSecret = randomUUID().replaceAll('-', '');
    }

    const artifact = deploymentArtifactDir(id, deploymentId);
    await fs.rm(artifact, { recursive: true, force: true });
    await fs.mkdir(artifact, { recursive: true });
    await fs.cp(tempBuild, artifact, { recursive: true });

    let dataMigrationSummary: JsonObject | null = null;
    {
      // Another process may have completed a release while this one was
      // building or waiting for the cutover lock. Refresh every retained field
      // and the restore pointer before mutating either database or the live dir.
      const currentApp = await db.query.apps.findFirst({
        where: (row, { eq: equal }) => equal(row.id, id),
      });
      if (!currentApp) throw new Error(`App "${id}" not found.`);
      // Capture a concurrent archive request, but never replace the original
      // state with the temporary `building` marker written by this deploy.
      if (currentApp.status !== 'building') {
        statusBeforeBuild = currentApp.status;
      }
      app = currentApp;
      prevDeploymentId = app.currentDeploymentId ?? null;
      dbName = app.dbName ?? dbName;
      dataDbName = app.dataDbName ?? dataDbName;
      dataSchemaHash = app.dataSchemaHash ?? dataSchemaHash;
      webhookSecret = app.webhookSecret ?? webhookSecret;
      signingSecret = app.signingSecret ?? signingSecret;
      userscriptSecret = app.userscriptSecret ?? userscriptSecret;
      keepDataFenceOnFailure = Boolean(app.dataActivationId);

      const currentDeployment = prevDeploymentId
        ? await db.query.deployments.findFirst({
            where: (row, { eq: equal }) =>
              equal(row.id, prevDeploymentId as string),
            columns: { dataSchemaHash: true },
          })
        : null;

      const usesDataTable = build.source.capabilities.dataTable;
      const targetDataSchema = build.dataSchema;
      if (usesDataTable && !targetDataSchema) {
        throw new Error('Data Table capability requires data/schema.ts.');
      }
      const claimedDataDbName = usesDataTable ? appDataDbName(id) : null;
      if (claimedDataDbName) dataDbName = claimedDataDbName;

      if (supersededPendingId) {
        if (app.dataActivationId !== supersededPendingId) {
          throw new Error(
            `App "${id}" changed while replacing activation ` +
              `${supersededPendingId}.`,
          );
        }
        // This release was confirmed absent, so no deployment row owns its
        // staged artifact. Remove it while the old fence still identifies the
        // directory; once the new attempt claims the fence it cannot be found
        // by recovery again.
        await fs.rm(deploymentArtifactDir(id, supersededPendingId), {
          recursive: true,
          force: true,
        });
      }

      // This committed fence is the cross-database failure boundary. Runtime
      // Data APIs return 503 while it is set. If the process crashes, the
      // session lock is released but the fence remains for the next deploy or
      // explicit rollback to recover without exposing mismatched code/schema.
      // Reserve the deterministic Data DB name in the same durable write before
      // provisioning it. Deletion can then clean up even if this process dies
      // after CREATE DATABASE but before the migration result is recorded.
      const claimedActivation = await db
        .update(schema.apps)
        .set({
          dataActivationId: deploymentId,
          ...(claimedDataDbName ? { dataDbName: claimedDataDbName } : {}),
        })
        .where(eq(schema.apps.id, id))
        .returning({ id: schema.apps.id });
      if (claimedActivation.length === 0) {
        throw new Error(`App "${id}" disappeared before Data DB provisioning.`);
      }
      dataFenceClaimed = true;

      if (usesDataTable && targetDataSchema) {
        let migration;
        try {
          migration = await applyDataMigration({
            id,
            deploymentId,
            schema: targetDataSchema,
            allowDestructive: options.allowDestructiveDataMigration,
            destructiveApprovalToken: options.dataMigrationApprovalToken,
          });
        } catch (error) {
          if (error instanceof DataMigrationOutcomeUnknown) {
            // Never expose a possibly committed schema to the previous code.
            keepDataFenceOnFailure = true;
          }
          throw error;
        }
        dataSchemaHash = migration.hash;
        deploymentDataSchemaHash = migration.hash;
        keepDataFenceOnFailure ||= Boolean(
          prevDeploymentId &&
          (currentDeployment?.dataSchemaHash ?? null) !== migration.hash,
        );
        dataMigrationSummary = {
          applied: migration.applied,
          destructive: migration.plan.destructive,
          fromHash: migration.plan.fromHash,
          toHash: migration.plan.toHash,
          approvalToken: migration.plan.approvalToken,
          steps: migration.plan.steps.map((step) => ({
            description: step.description,
            destructive: step.destructive,
          })),
        } as unknown as JsonObject;

        // Keep the platform's latest-schema metadata honest even if release
        // activation later fails. The fence remains owned by this deployment.
        await db
          .update(schema.apps)
          .set({ dataDbName, dataSchemaHash })
          .where(
            and(
              eq(schema.apps.id, id),
              eq(schema.apps.dataActivationId, deploymentId),
            ),
          );
      }

      // The build passed, so this release earns the next version number. The
      // version → tag → record critical section runs under the existing
      // cross-process app lock. The Data cutover session lock additionally
      // orders migrations and activation in the same sequence.
      const releaseBuild = build;
      await db.transaction(async (tx) => {
        await appDeployLock.acquire(tx, id);
        const last = await tx.query.deployments.findFirst({
          where: (d, { eq: e }) => e(d.appId, id),
          orderBy: (d, { desc }) => [desc(d.version)],
        });
        version = (last?.version ?? 0) + 1;

        const published = await publishDeploymentSource(id, sourceDir, version);
        publishedTag = published.tag;

        // Record the release first, then swap the live build dir as the LAST
        // step. Keep dataActivationId set through COMMIT and post-commit runtime
        // finalization so an unavailable acknowledgement remains recoverable.
        await tx.insert(schema.deployments).values({
          id: deploymentId,
          appId: id,
          version,
          status: 'deployed',
          message,
          manifestNormalized: releaseBuild.normalized as unknown as JsonObject,
          dataSchemaSnapshot: releaseBuild.dataSchema as unknown as JsonObject,
          dataSchemaHash: deploymentDataSchemaHash,
          dataMigrationSummary,
          sourceCommit: published.commit,
          sourceTag: published.tag,
          artifactPath: workspaceRelative(artifact),
          buildLog: releaseBuild.log,
        });

        await tx
          .update(schema.apps)
          .set({
            status: 'deployed',
            name: releaseBuild.source.name,
            description: releaseBuild.source.description || null,
            capabilities: releaseBuild.source.capabilities,
            backendMode: releaseBuild.source.backendMode,
            manifest: releaseBuild.source as unknown as JsonObject,
            repoPath: published.repoPath,
            currentSourceCommit: published.commit,
            dbName,
            dataDbName,
            dataSchemaHash,
            dataActivationId: deploymentId,
            webhookSecret,
            signingSecret,
            userscriptSecret,
            // Served as the userscript `@version`. Bumped on every activation
            // (deploy AND rollback) so Tampermonkey always sees a higher version
            // and re-fetches — the deployment version alone would go backwards
            // on rollback and installed scripts would never pick up the change.
            userscriptRevision: sql`${schema.apps.userscriptRevision} + 1`,
            currentDeploymentId: deploymentId,
          })
          .where(eq(schema.apps.id, id));

        // Live swap is the last statement so an insert/update failure leaves
        // the previous build untouched. Data access stays fenced until COMMIT.
        liveTouched = true;
        const live = appBuildDir(id);
        await fs.rm(liveBackup, { recursive: true, force: true });
        if (await pathExists(live)) {
          await fs.rename(live, liveBackup);
        }
        // Both directories share WORKSPACE_ROOT, so rename installs the fully
        // built tree atomically. Serving can observe a brief missing path, but
        // never a partially copied bundle or a marker from different bytes.
        await fs.rename(tempBuild, live);
        releaseCallbackCompleted = true;
      });
      // Set only after the platform tx commits. A rollback after insert would
      // otherwise leave this true with no row and strand the release tag.
      recorded = true;
    }
    await finishCommittedRelease(
      id,
      liveBackup,
      deploymentId,
      build.source.backendMode === 'long-running' &&
        build.source.capabilities.backend,
    );

    return {
      deploymentId,
      version,
      normalized: build.normalized,
      log: build.log,
    };
  } catch (error) {
    // A connection can report COMMIT failure after PostgreSQL actually committed.
    // Reconcile by deployment id before any cleanup so commit uncertainty never
    // deletes a valid artifact or restores the previous live build over a release
    // the platform DB already made current.
    // A callback that never returned cannot have reached COMMIT. Only the
    // post-callback rejection needs cross-connection reconciliation.
    let releaseAbsenceConfirmed = !releaseCallbackCompleted;
    if (!recorded && releaseCallbackCompleted) {
      // `undefined` means the lock/read itself never completed. Once the read
      // completed its result is authoritative even if closing the surrounding
      // read-only transaction later reports a connection error.
      let committedVersion: number | null | undefined;
      try {
        await db.transaction(async (tx) => {
          // A disconnected client can receive a COMMIT error while PostgreSQL
          // is still finishing that transaction. Wait for its advisory lock
          // before checking the row; otherwise this connection can observe
          // absence and start destructive cleanup just before the COMMIT becomes
          // visible.
          await appDeployLock.acquire(tx, id);
          const committed = await tx.query.deployments.findFirst({
            where: (row, { eq: equal }) => equal(row.id, deploymentId),
            columns: { id: true, version: true },
          });
          committedVersion = committed?.version ?? null;
        });
      } catch {
        // Preserve files on uncertainty; later reconciliation can clean an
        // orphan, but deleting a committed release would break rollback.
      }
      if (committedVersion !== undefined) {
        recorded = committedVersion !== null;
        if (committedVersion !== null) version = committedVersion;
        releaseAbsenceConfirmed = committedVersion === null;
      }
    }
    const releaseOutcomeUnknown =
      releaseCallbackCompleted && !recorded && !releaseAbsenceConfirmed;
    if (releaseOutcomeUnknown) {
      // The durable fence is also the recovery marker for the pending release.
      // Leave status/files/fence untouched until the original COMMIT becomes
      // visible or a later deploy/explicit rollback reconciles the exact id.
      keepDataFenceOnFailure = true;
    }
    if (recorded && build) {
      // The release transaction committed and is already live. Finish the same
      // idempotent post-commit work as the ordinary success path and report
      // success instead of falling through to destructive failure cleanup.
      await finishCommittedRelease(
        id,
        liveBackup,
        deploymentId,
        build.source.backendMode === 'long-running' &&
          build.source.capabilities.backend,
      );
      return {
        deploymentId,
        version,
        normalized: build.normalized,
        log: build.log,
      };
    }
    // If the live dir was swapped but the release wasn't recorded (only a COMMIT
    // failure can reach here), the app would otherwise serve unrecorded files
    // while the DB still points at the previous deployment. Put the previous
    // build back so the filesystem and DB agree.
    let liveRecoveryConfirmed = !liveTouched;
    if (liveTouched && !recorded && releaseAbsenceConfirmed) {
      liveRecoveryConfirmed = await restoreLiveBuild(
        id,
        prevDeploymentId,
        liveBackup,
      ).catch(() => false);
      if (!liveRecoveryConfirmed) {
        // Keep the durable activation marker and the failed release artifact.
        // Clearing either after a failed restore would leave the platform row
        // pointing at the previous deployment while the mutable live directory
        // still contains unrecorded bytes, with no explicit recovery state.
        keepDataFenceOnFailure = true;
      }
    }
    // Only remove the version tag after both release absence and live recovery
    // are confirmed. When live restoration fails, the source tag is part of the
    // durable recovery material alongside the artifact and activation fence.
    // Re-check ownership UNDER the per-app advisory lock: otherwise a concurrent
    // deploy could be mid-critical-section (its deploy/v<n> tag force-moved but
    // its row not yet committed) and we'd delete the tag that release will own.
    if (
      publishedTag &&
      !recorded &&
      releaseAbsenceConfirmed &&
      liveRecoveryConfirmed
    ) {
      const tag = publishedTag;
      await db
        .transaction(async (tx) => {
          await appDeployLock.acquire(tx, id);
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
    // The artifact snapshot was staged before the release was recorded; with no
    // deployment row referencing it, it would sit orphaned on disk forever.
    if (!recorded && releaseAbsenceConfirmed && liveRecoveryConfirmed) {
      await fs
        .rm(deploymentArtifactDir(id, deploymentId), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    }
    // Restore only a temporary marker whose release/schema outcome is known.
    // A concurrent archive/unarchive is an explicit user action and must win;
    // an unresolved activation keeps its durable fence + visible building state
    // until a retry or explicit rollback completes recovery.
    const preserveActivationState =
      !recorded && (releaseOutcomeUnknown || keepDataFenceOnFailure);
    if (!preserveActivationState) {
      await db
        .update(schema.apps)
        .set({
          status: recorded
            ? 'deployed'
            : statusBeforeBuild === 'archived'
              ? 'archived'
              : app.currentDeploymentId
                ? 'deployed'
                : 'failed',
        })
        .where(and(eq(schema.apps.id, id), eq(schema.apps.status, 'building')));
    }
    if (
      !preserveActivationState &&
      dataFenceClaimed &&
      !keepDataFenceOnFailure
    ) {
      await db
        .update(schema.apps)
        .set({ dataActivationId: null })
        .where(
          and(
            eq(schema.apps.id, id),
            eq(schema.apps.dataActivationId, deploymentId),
          ),
        )
        .catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(path.dirname(tempBuild), { recursive: true, force: true });
  }
}
