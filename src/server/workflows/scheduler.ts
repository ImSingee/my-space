/** Server-only: cron scheduler that starts workflow runs on schedule. */
import { db } from '~/db';
import { workflowCompatibility } from '~/workflow-compatibility';
import { nextRun, parseCron } from '~server/apps/cron-expr';
import { createCronScheduler } from '~server/cron-scheduler';
import { startWorkflowRun } from './execute';
import type { NormalizedWorkflowManifest, WorkflowCronJob } from './manifest';

/** Read cron jobs from a workflow's current deployment normalized manifest. */
async function cronJobsFor(workflowId: string): Promise<WorkflowCronJob[]> {
  const workflow = await db.query.workflows.findFirst({
    where: { id: workflowId },
  });
  if (
    !workflow ||
    workflow.status !== 'deployed' ||
    !workflow.currentDeploymentId
  ) {
    return [];
  }
  const deployment = await db.query.workflowDeployments.findFirst({
    where: { id: workflow.currentDeploymentId as string },
  });
  const manifest =
    deployment?.manifestNormalized as NormalizedWorkflowManifest | null;
  return manifest?.triggers?.cron ?? [];
}

async function fire(workflowId: string, job: WorkflowCronJob): Promise<void> {
  try {
    await startWorkflowRun(workflowId, {
      trigger: 'cron',
      input: job.input ?? {},
    });
  } catch {
    /* a failed start is recorded as a failed run where possible */
  }
}

/** Load only compatibility-supported deployments into the automatic timer set. */
export async function loadWorkflowCronSchedule(): Promise<
  { ownerId: string; jobs: WorkflowCronJob[] }[]
> {
  const workflows = await db.query.workflows.findMany({
    where: { status: 'deployed' },
    columns: { id: true, currentDeploymentId: true },
  });
  const deployed = workflows.filter((workflow) =>
    Boolean(workflow.currentDeploymentId),
  );
  if (deployed.length === 0) return [];

  const deployments = await db.query.workflowDeployments.findMany({
    where: {
      id: {
        in: deployed.map((workflow) => workflow.currentDeploymentId as string),
      },
    },
    columns: {
      id: true,
      manifestNormalized: true,
      compatibilityVersion: true,
    },
  });
  const manifestByDeploymentId = new Map(
    deployments
      .filter(
        (deployment) =>
          workflowCompatibility(deployment.compatibilityVersion).isSupported,
      )
      .map((deployment) => [
        deployment.id,
        deployment.manifestNormalized as NormalizedWorkflowManifest | null,
      ]),
  );
  return deployed.map((workflow) => ({
    ownerId: workflow.id,
    jobs:
      manifestByDeploymentId.get(workflow.currentDeploymentId as string)
        ?.triggers?.cron ?? [],
  }));
}

const scheduler = createCronScheduler<WorkflowCronJob>({
  globalKey: '__hatchWorkflowScheduler__',
  // Index is part of the key so two cron jobs that share a `name` get distinct
  // timers instead of the second clobbering the first.
  jobKey: (workflowId, job, index) => `${workflowId}::${index}::${job.name}`,
  schedule: (job) => job.schedule,
  fire,
  loadJobs: loadWorkflowCronSchedule,
});

/** Start the scheduler once (idempotent). Safe to call from any server entry. */
export function ensureWorkflowScheduler(): void {
  scheduler.ensure();
}

/** Reload all schedules (call after a deploy/rollback/delete). */
export async function reloadWorkflowScheduler(): Promise<void> {
  await scheduler.reload();
}

export type WorkflowCronView = {
  name: string;
  schedule: string;
  nextRun: string | null;
};

/** List a workflow's cron jobs with their next computed run time (for UI). */
export async function listWorkflowCronJobs(
  workflowId: string,
): Promise<WorkflowCronView[]> {
  const jobs = await cronJobsFor(workflowId);
  return jobs.map((job) => {
    let next: string | null = null;
    try {
      next = nextRun(parseCron(job.schedule))?.toISOString() ?? null;
    } catch {
      next = null;
    }
    return { name: job.name, schedule: job.schedule, nextRun: next };
  });
}
