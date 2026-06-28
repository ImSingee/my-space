/** Server-only: build + record a workflow deployment and flip it live. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  WORKFLOW_BUILD_WORK_DIR,
  WORKSPACE_ROOT,
  workflowCurrentDir,
  workflowDeploymentArtifactDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import type { JsonObject } from '~/db/schema';
import { buildWorkflow } from './build';
import {
  assertDeployableWorktree,
  deleteDeploymentTag,
  prepareDeployCheckout,
  publishDeploymentSource,
} from './git';
import type { NormalizedWorkflowManifest } from './manifest';
import { reloadWorkflowScheduler } from './scheduler';

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

export async function deployWorkflow(
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

    let webhookSecret = workflow.webhookSecret ?? null;
    if (build.source.triggers.webhook && !webhookSecret) {
      webhookSecret = randomUUID().replaceAll('-', '');
    }

    const artifact = workflowDeploymentArtifactDir(id, deploymentId);
    await fs.rm(artifact, { recursive: true, force: true });
    await fs.mkdir(artifact, { recursive: true });
    await fs.cp(tempBuild, artifact, { recursive: true });

    const last = await db.query.workflowDeployments.findFirst({
      where: (d, { eq: e }) => e(d.workflowId, id),
      orderBy: (d, { desc }) => [desc(d.version)],
    });
    const version = (last?.version ?? 0) + 1;

    const published = await publishDeploymentSource(id, sourceDir, version);
    publishedTag = published.tag;

    const live = workflowCurrentDir(id);
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(live, { recursive: true });
    await fs.cp(tempBuild, live, { recursive: true });

    await db.insert(schema.workflowDeployments).values({
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

    await db
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

    // Pick up cron schedule changes from the new deployment.
    await reloadWorkflowScheduler();

    return {
      deploymentId,
      version,
      normalized: build.normalized,
      inputSchema: build.inputSchema,
      log: build.log,
    };
  } catch (error) {
    if (publishedTag) {
      await deleteDeploymentTag(id, publishedTag).catch(() => {});
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
