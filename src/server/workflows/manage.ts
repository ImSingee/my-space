/** Server-only: workflow lifecycle management + run inspection views. */
import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import {
  workflowArtifactsDir,
  workflowCurrentDir,
  workflowDeploymentArtifactDir,
  workflowRepoDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import type {
  JsonValue,
  WorkflowDeploymentStatus,
  WorkflowRunStatus,
  WorkflowRunStepStatus,
  WorkflowStatus,
  WorkflowTrigger,
} from '~/db/schema';
import { workflowDeployLock } from './deploy';
import { moveMasterToDeploymentTag } from './git';
import { isValidWorkflowId } from './manifest';
import { reloadWorkflowScheduler } from './scheduler';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export type WorkflowDeploymentSummary = {
  id: string;
  version: number;
  status: WorkflowDeploymentStatus;
  message: string | null;
  error: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
  sourceCommit: string | null;
  sourceTag: string | null;
  hasArtifact: boolean;
  hasBuildLog: boolean;
};

export async function listWorkflowDeployments(
  id: string,
): Promise<WorkflowDeploymentSummary[]> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
  });
  const rows = await db.query.workflowDeployments.findMany({
    where: { workflowId: id },
    orderBy: { version: 'desc' },
  });
  const current = workflow?.currentDeploymentId ?? null;
  return Promise.all(
    rows.map(async (d) => {
      const isCurrent = d.id === current;
      const hasArtifact = d.artifactPath
        ? await pathExists(workflowDeploymentArtifactDir(id, d.id))
        : false;
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

export async function workflowDeploymentBuildLog(
  workflowId: string,
  deploymentId: string,
): Promise<string | null> {
  const d = await db.query.workflowDeployments.findFirst({
    where: { workflowId, id: deploymentId },
  });
  return d?.buildLog ?? null;
}

export async function setWorkflowArchived(
  id: string,
  archived: boolean,
): Promise<{ status: WorkflowStatus }> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
  });
  if (!workflow) throw new Error(`Workflow "${id}" not found.`);

  const status: WorkflowStatus = archived
    ? 'archived'
    : workflow.currentDeploymentId
      ? 'deployed'
      : 'draft';

  await db
    .update(schema.workflows)
    .set({ status })
    .where(eq(schema.workflows.id, id));
  // Archived workflows must not keep firing cron; restored ones resume.
  await reloadWorkflowScheduler();
  return { status };
}

/**
 * Roll a workflow back to a previous deployment by flipping the deployment
 * pointer. Serialized with deploys via the shared per-workflow lock so a
 * rollback and a deploy can't interleave their Git/row mutations and leave the
 * DB pointing at one version while `master` points at another.
 */
export function rollbackWorkflow(
  id: string,
  deploymentId: string,
): Promise<{ version: number }> {
  return workflowDeployLock.withLock(id, () =>
    rollbackWorkflowInner(id, deploymentId),
  );
}

async function rollbackWorkflowInner(
  id: string,
  deploymentId: string,
): Promise<{ version: number }> {
  const workflow = await db.query.workflows.findFirst({
    where: { id },
  });
  if (!workflow) throw new Error(`Workflow "${id}" not found.`);

  const deployment = await db.query.workflowDeployments.findFirst({
    where: { id: deploymentId },
  });
  if (!deployment || deployment.workflowId !== id) {
    throw new Error('Deployment not found for this workflow.');
  }
  if (deployment.status !== 'deployed') {
    throw new Error('Only successful deployments can be restored.');
  }
  const artifact = workflowDeploymentArtifactDir(id, deploymentId);
  if (!(await pathExists(artifact))) {
    throw new Error(
      `No artifact exists for v${deployment.version} and it cannot be restored.`,
    );
  }
  if (!deployment.sourceTag) {
    throw new Error(
      `Deployment v${deployment.version} has no source tag and cannot restore.`,
    );
  }

  const manifest = deployment.manifestNormalized as {
    name?: string;
    description?: string;
  } | null;
  const sourceTag = deployment.sourceTag;

  // Mutate Git master and the workflow row under the same advisory lock deploy
  // holds for its version→tag→record step, so a concurrent deploy on another
  // process blocks until we finish (and vice versa). Runs execute the immutable
  // per-deployment artifact directly (see execute.ts), so flipping
  // `currentDeploymentId` is what makes this version live.
  await db.transaction(async (tx) => {
    await workflowDeployLock.acquire(tx, id);
    const sourceCommit = await moveMasterToDeploymentTag(id, sourceTag);

    await tx
      .update(schema.workflows)
      .set({
        status: 'deployed',
        currentDeploymentId: deployment.id,
        currentSourceCommit: sourceCommit,
        inputSchema: deployment.inputSchema,
        manifest: deployment.manifestNormalized,
        name: manifest?.name ?? workflow.name,
        // Restore the rolled-back version's description too; otherwise the row
        // keeps a newer deployment's metadata after rolling back (mirrors the
        // `description || null` normalization the deploy path applies).
        description: manifest?.description || null,
      })
      .where(eq(schema.workflows.id, id));
  });

  await reloadWorkflowScheduler();
  return { version: deployment.version };
}

export async function rollbackWorkflowToVersion(
  id: string,
  version: number,
): Promise<{ version: number }> {
  const deployment = await db.query.workflowDeployments.findFirst({
    where: { workflowId: id, version },
  });
  if (!deployment) {
    throw new Error(`Workflow "${id}" has no deployment v${version}.`);
  }
  return rollbackWorkflow(id, deployment.id);
}

/** Permanently delete a workflow's Platform-owned state. */
export async function deleteWorkflow(id: string): Promise<{ ok: true }> {
  // The id flows into `fs.rm(..., { force: true })` on several per-workflow
  // dirs (whose helpers `path.resolve`), so reject anything that isn't a valid
  // slug before touching the filesystem. Otherwise a crafted id like
  // "../../src" (which matches no DB row) would still resolve outside the
  // workflow namespace and delete arbitrary directories.
  if (!isValidWorkflowId(id)) {
    throw new Error(`Invalid workflow id: ${id}`);
  }
  // Kill any in-flight run processes first so deleting the rows below cannot
  // strand an orphaned Deno child that keeps causing side effects.
  const { killActiveWorkflowRuns } = await import('./execute');
  await killActiveWorkflowRuns(id);
  // Cascades to deployments, runs, and run steps.
  await db.delete(schema.workflows).where(eq(schema.workflows.id, id));
  await Promise.all([
    // Legacy live-bundle dir: older deploys mirrored the artifact into
    // workflow-current/<id>. Nothing writes or reads it anymore, but sweep it
    // for workflows created before it was retired.
    fs.rm(workflowCurrentDir(id), { recursive: true, force: true }),
    fs.rm(workflowArtifactsDir(id), { recursive: true, force: true }),
    fs.rm(workflowRepoDir(id), { recursive: true, force: true }),
  ]);
  await reloadWorkflowScheduler();
  return { ok: true };
}

/* ------------------------------- run views -------------------------------- */

export type WorkflowRunSummary = {
  id: string;
  trigger: WorkflowTrigger;
  status: WorkflowRunStatus;
  version: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Whole-second run duration, when both timestamps exist. */
  durationMs: number | null;
  stepCount: number;
};

export async function listWorkflowRuns(
  id: string,
  limit = 50,
): Promise<WorkflowRunSummary[]> {
  const rows = await db.query.workflowRuns.findMany({
    where: { workflowId: id },
    orderBy: { createdAt: 'desc' },
    limit,
  });
  const steps = await db.query.workflowRunSteps.findMany({
    where: { runId: { in: rows.map((r) => r.id) } },
  });
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.runId, (counts.get(s.runId) ?? 0) + 1);

  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    version: r.version,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs:
      r.startedAt && r.finishedAt
        ? r.finishedAt.getTime() - r.startedAt.getTime()
        : null,
    stepCount: counts.get(r.id) ?? 0,
  }));
}

/** A run summary tagged with its owning workflow, for the global view. */
export type WorkflowRunGlobalItem = WorkflowRunSummary & {
  workflowId: string;
  workflowName: string;
};

/** Recent executions across every workflow, newest first. */
export async function listRecentWorkflowRuns(
  limit = 100,
): Promise<WorkflowRunGlobalItem[]> {
  const rows = await db.query.workflowRuns.findMany({
    orderBy: { createdAt: 'desc' },
    limit,
  });
  if (rows.length === 0) return [];

  const steps = await db.query.workflowRunSteps.findMany({
    where: { runId: { in: rows.map((r) => r.id) } },
  });
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.runId, (counts.get(s.runId) ?? 0) + 1);

  const workflows = await db.query.workflows.findMany();
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));

  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    version: r.version,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs:
      r.startedAt && r.finishedAt
        ? r.finishedAt.getTime() - r.startedAt.getTime()
        : null,
    stepCount: counts.get(r.id) ?? 0,
    workflowId: r.workflowId,
    workflowName: nameById.get(r.workflowId) ?? r.workflowId,
  }));
}

export type WorkflowRunStepView = {
  seq: number;
  name: string;
  status: WorkflowRunStepStatus;
  attempt: number;
  output: JsonValue | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

export type WorkflowRunDetail = {
  id: string;
  workflowId: string;
  trigger: WorkflowTrigger;
  status: WorkflowRunStatus;
  version: number | null;
  input: JsonValue | null;
  output: JsonValue | null;
  error: string | null;
  log: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  steps: WorkflowRunStepView[];
};

export async function getWorkflowRun(
  runId: string,
): Promise<WorkflowRunDetail | null> {
  const run = await db.query.workflowRuns.findFirst({
    where: { id: runId },
  });
  if (!run) return null;
  const steps = await db.query.workflowRunSteps.findMany({
    where: { runId },
    orderBy: { seq: 'asc', attempt: 'asc' },
  });
  return {
    id: run.id,
    workflowId: run.workflowId,
    trigger: run.trigger,
    status: run.status,
    version: run.version,
    input: run.input ?? null,
    output: run.output ?? null,
    error: run.error,
    log: run.log,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs:
      run.startedAt && run.finishedAt
        ? run.finishedAt.getTime() - run.startedAt.getTime()
        : null,
    steps: steps.map((s) => ({
      seq: s.seq,
      name: s.name,
      status: s.status,
      attempt: s.attempt,
      output: s.output ?? null,
      error: s.error,
      startedAt: s.startedAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
      durationMs:
        s.startedAt && s.finishedAt
          ? s.finishedAt.getTime() - s.startedAt.getTime()
          : null,
    })),
  };
}
