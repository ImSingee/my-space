/** Server-only: cron scheduler that starts workflow runs on schedule. */
import { db } from '~/db';
import { nextRun, parseCron } from '~server/apps/cron-expr';
import { startWorkflowRun } from './execute';
import type { NormalizedWorkflowManifest, WorkflowCronJob } from './manifest';

type SchedulerGlobal = typeof globalThis & {
  __hatchWorkflowScheduler__?: {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    started: boolean;
  };
};

function state() {
  const g = globalThis as SchedulerGlobal;
  g.__hatchWorkflowScheduler__ ??= { timers: new Map(), started: false };
  return g.__hatchWorkflowScheduler__;
}

function jobKey(workflowId: string, jobName: string): string {
  return `${workflowId}::${jobName}`;
}

/** Read cron jobs from a workflow's current deployment normalized manifest. */
async function cronJobsFor(workflowId: string): Promise<WorkflowCronJob[]> {
  const workflow = await db.query.workflows.findFirst({
    where: (s, { eq }) => eq(s.id, workflowId),
  });
  if (
    !workflow ||
    workflow.status !== 'deployed' ||
    !workflow.currentDeploymentId
  ) {
    return [];
  }
  const deployment = await db.query.workflowDeployments.findFirst({
    where: (d, { eq }) => eq(d.id, workflow.currentDeploymentId as string),
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

function scheduleOne(workflowId: string, job: WorkflowCronJob): void {
  const s = state();
  const key = jobKey(workflowId, job.name);
  const existing = s.timers.get(key);
  if (existing) clearTimeout(existing);

  let spec: ReturnType<typeof parseCron>;
  try {
    spec = parseCron(job.schedule);
  } catch {
    return;
  }
  const next = nextRun(spec);
  if (!next) return;

  const maxDelay = 6 * 60 * 60 * 1000;
  const delay = Math.min(Math.max(next.getTime() - Date.now(), 1000), maxDelay);
  const timer = setTimeout(() => {
    const reached = nextRun(spec, new Date(Date.now() - 60_000));
    const due = !reached || reached.getTime() <= Date.now() + 1000;
    if (due) {
      void fire(workflowId, job).finally(() => scheduleOne(workflowId, job));
    } else {
      scheduleOne(workflowId, job);
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  s.timers.set(key, timer);
}

function clearAll(): void {
  const s = state();
  for (const timer of s.timers.values()) clearTimeout(timer);
  s.timers.clear();
}

async function loadAll(): Promise<void> {
  const workflows = await db.query.workflows.findMany({
    where: (s, { eq }) => eq(s.status, 'deployed'),
  });
  for (const workflow of workflows) {
    const jobs = await cronJobsFor(workflow.id);
    for (const job of jobs) scheduleOne(workflow.id, job);
  }
}

/** Start the scheduler once (idempotent). Safe to call from any server entry. */
export function ensureWorkflowScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  // Allow a retry if the very first load fails (e.g. called at boot before the
  // database is reachable); a later deploy/rollback or page load re-runs it.
  void loadAll().catch(() => {
    s.started = false;
  });
}

/** Reload all schedules (call after a deploy/rollback/delete). */
export async function reloadWorkflowScheduler(): Promise<void> {
  state().started = true;
  clearAll();
  await loadAll();
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
