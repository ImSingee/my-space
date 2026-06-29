/** Server-only: build + record a workflow deployment and flip it live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  WORKFLOW_BUILD_WORK_DIR,
  WORKSPACE_ROOT,
  workflowCurrentDir,
  workflowDeploymentArtifactDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { validateCron } from '~server/apps/cron-expr';
import { buildWorkflow } from './build';
import {
  assertDeployableWorktree,
  deleteDeploymentTag,
  prepareDeployCheckout,
  publishDeploymentSource,
} from './git';
import type { NormalizedWorkflowManifest } from './manifest';
import { reloadWorkflowScheduler } from './scheduler';
import { validateWorkflowInput } from './validate';

export type DeployWorkflowResult = {
  deploymentId: string;
  version: number;
  normalized: NormalizedWorkflowManifest;
  inputSchema: Record<string, unknown>;
  log: string;
};

export type DeployWorkflowOptions = {
  sourceDir?: string;
  /** Required release note recorded on the deployment. */
  message: string;
};

function workspaceRelative(p: string): string {
  return path.relative(WORKSPACE_ROOT, p).split(path.sep).join('/');
}

// Advisory-lock namespace for workflow deploys (distinct from apps) so version
// allocation is serialized across server processes, not just within one. Shared
// with rollback (see manage.ts) so the two can't interleave their artifact/Git/
// row mutations.
export const WORKFLOW_DEPLOY_LOCK_NS = 2;

const workflowDeployChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` only after any in-flight deploy (or rollback) for the same workflow
 * has settled. Exported so rollback shares the same in-process serialization.
 */
export function withWorkflowDeployLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = workflowDeployChains.get(id) ?? Promise.resolve();
  // Chain regardless of the previous deploy's outcome — a failed deploy must not
  // wedge later attempts for the same workflow.
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  workflowDeployChains.set(id, tail);
  void tail.finally(() => {
    if (workflowDeployChains.get(id) === tail) workflowDeployChains.delete(id);
  });
  return run;
}

/**
 * Build + record a workflow deployment and flip it live. Serialized per workflow
 * so two concurrent deploys can't both read the same latest version, assign the
 * same next version, and force-move the same `deploy/v<n>` tag onto different
 * commits.
 */
export function deployWorkflow(
  id: string,
  options: DeployWorkflowOptions,
): Promise<DeployWorkflowResult> {
  return withWorkflowDeployLock(id, () => deployWorkflowInner(id, options));
}

async function deployWorkflowInner(
  id: string,
  options: DeployWorkflowOptions,
): Promise<DeployWorkflowResult> {
  const message = options.message?.trim();
  if (!message) {
    throw new Error('A deployment message is required.');
  }

  const workflow = await db.query.workflows.findFirst({
    where: (s, { eq: e }) => e(s.id, id),
  });
  if (!workflow) {
    throw new Error(`Workflow "${id}" not found.`);
  }

  const sourceDir = options.sourceDir ?? (await prepareDeployCheckout(id));
  await assertDeployableWorktree(id, sourceDir);

  // A deployment row records a successful release only — a failed build leaves
  // no row and burns no version number. Mint the id up front to key dirs.
  const deploymentId = ulid().toLowerCase();
  const tempBuild = path.join(WORKFLOW_BUILD_WORK_DIR, id, deploymentId, 'out');
  let publishedTag: string | undefined;
  // Once the deployment row exists it references `publishedTag` as its sourceTag,
  // so a later failure (e.g. a scheduler reload error) must NOT delete that tag.
  let recorded = false;

  try {
    await db
      .update(schema.workflows)
      .set({ status: 'building' })
      .where(eq(schema.workflows.id, id));

    const build = await buildWorkflow(id, {
      sourceDir,
      outputDir: tempBuild,
    });

    // The webhook URL and all on-disk namespaces key off the deployed `id`, so
    // a manifest whose id drifted would advertise a webhook the handler can't
    // resolve. Reject the mismatch instead of shipping a broken trigger.
    if (build.source.id !== id) {
      throw new Error(
        `manifest.json id "${build.source.id}" does not match the workflow ` +
          `being deployed ("${id}"). Set "id": "${id}" in manifest.json.`,
      );
    }

    // Fail the deploy on cron triggers that would silently never fire (the
    // scheduler skips an unparseable schedule) or always fail at runtime (input
    // that doesn't satisfy the workflow's captured input schema), instead of
    // publishing a release whose schedule is dead on arrival.
    for (const job of build.source.triggers.cron) {
      const cronError = validateCron(job.schedule);
      if (cronError) {
        throw new Error(
          `Invalid cron schedule for job "${job.name}": ${cronError}`,
        );
      }
      const inputCheck = validateWorkflowInput(
        build.inputSchema,
        job.input ?? {},
      );
      if (!inputCheck.success) {
        throw new Error(
          `Invalid cron input for job "${job.name}": ${inputCheck.message}`,
        );
      }
    }

    let webhookSecret = workflow.webhookSecret ?? null;
    if (build.source.triggers.webhook && !webhookSecret) {
      webhookSecret = randomUUID().replaceAll('-', '');
    }

    const artifact = workflowDeploymentArtifactDir(id, deploymentId);
    await fs.rm(artifact, { recursive: true, force: true });
    await fs.mkdir(artifact, { recursive: true });
    await fs.cp(tempBuild, artifact, { recursive: true });

    // version → tag → record runs under a per-workflow advisory lock (held for
    // the transaction) so concurrent deploys on different processes can't both
    // allocate the same version and force-move deploy/v<n> onto different
    // commits; the loser blocks, then takes the next number.
    let version = 0;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${WORKFLOW_DEPLOY_LOCK_NS}, hashtext(${id}))`,
      );
      const last = await tx.query.workflowDeployments.findFirst({
        where: (d, { eq: e }) => e(d.workflowId, id),
        orderBy: (d, { desc }) => [desc(d.version)],
      });
      version = (last?.version ?? 0) + 1;

      const published = await publishDeploymentSource(id, sourceDir, version);
      publishedTag = published.tag;

      const live = workflowCurrentDir(id);
      await fs.rm(live, { recursive: true, force: true });
      await fs.mkdir(live, { recursive: true });
      await fs.cp(tempBuild, live, { recursive: true });

      await tx.insert(schema.workflowDeployments).values({
        id: deploymentId,
        workflowId: id,
        version,
        status: 'deployed',
        message,
        manifestNormalized: build.normalized as unknown as JsonObject,
        inputSchema: build.inputSchema as JsonObject,
        sourceCommit: published.commit,
        sourceTag: published.tag,
        artifactPath: workspaceRelative(artifact),
        buildLog: build.log,
      });

      await tx
        .update(schema.workflows)
        .set({
          status: 'deployed',
          name: build.source.name,
          description: build.source.description || null,
          manifest: build.source as unknown as JsonObject,
          inputSchema: build.inputSchema as JsonObject,
          repoPath: published.repoPath,
          currentSourceCommit: published.commit,
          webhookSecret,
          currentDeploymentId: deploymentId,
        })
        .where(eq(schema.workflows.id, id));
    });
    // Set only after the tx commits: a rollback after the insert would otherwise
    // leave `recorded` true with no row, stranding the force-moved tag.
    recorded = true;

    // Pick up cron schedule changes from the new deployment. Best-effort
    // post-commit work: the release is already recorded and live, so a reload
    // failure must neither fail the deploy nor trip the cleanup path below (which
    // would delete this recorded deployment's source tag).
    await reloadWorkflowScheduler().catch(() => {});

    return {
      deploymentId,
      version,
      normalized: build.normalized,
      inputSchema: build.inputSchema,
      log: build.log,
    };
  } catch (error) {
    // Only remove the version tag for a release that was never recorded — once a
    // deployment row exists it references this tag. We re-check ownership and
    // delete UNDER the per-workflow advisory lock: otherwise a concurrent deploy
    // could be mid-critical-section (its deploy/v<n> tag force-moved but its row
    // not yet committed) and we'd delete the tag its successful release will
    // reference. Holding the lock serializes us with that deploy.
    if (publishedTag && !recorded) {
      const tag = publishedTag;
      await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${WORKFLOW_DEPLOY_LOCK_NS}, hashtext(${id}))`,
          );
          const owner = await tx.query.workflowDeployments.findFirst({
            where: (d, { eq: e, and: a }) =>
              a(e(d.workflowId, id), e(d.sourceTag, tag)),
          });
          if (!owner) {
            await deleteDeploymentTag(id, tag).catch(() => {});
          }
        })
        .catch(() => {});
    }
    // Restore the prior status: an archived workflow must stay archived (a
    // failed redeploy must not silently re-enable its cron/webhook triggers),
    // one with a live deployment keeps serving it, and a never-deployed one is
    // marked failed.
    await db
      .update(schema.workflows)
      .set({
        status:
          workflow.status === 'archived'
            ? 'archived'
            : workflow.currentDeploymentId
              ? 'deployed'
              : 'failed',
      })
      .where(eq(schema.workflows.id, id));
    throw error;
  } finally {
    await fs.rm(path.dirname(tempBuild), { recursive: true, force: true });
  }
}
