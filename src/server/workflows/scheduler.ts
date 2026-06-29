/** Server-only: cron scheduler that starts workflow runs on schedule. */
import { db } from '~/db';
import { nextRun, parseCron } from '~server/apps/cron-expr';
import { startWorkflowRun } from './execute';
import type { NormalizedWorkflowManifest, WorkflowCronJob } from './manifest';

type SchedulerGlobal = typeof globalThis & {
  __hatchWorkflowScheduler__?: {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    started: boolean;
    /**
     * Bumped on every clearAll() so stale timer callbacks can self-cancel.
     * Optional because a hot reload can leave an older-shaped object on
     * globalThis; readers treat a missing value as 0 so `++` never yields NaN
     * (which would compare unequal to every captured generation and silently
     * stop all timers from firing).
     */
    generation?: number;
  };
};

function state() {
  const g = globalThis as SchedulerGlobal;
  g.__hatchWorkflowScheduler__ ??= {
    timers: new Map(),
    started: false,
    generation: 0,
  };
  return g.__hatchWorkflowScheduler__;
}

// Index is part of the key so two cron jobs that share a `name` get distinct
// timers instead of the second clobbering the first.
function jobKey(workflowId: string, index: number, jobName: string): string {
  return `${workflowId}::${index}::${jobName}`;
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

function scheduleOne(
  workflowId: string,
  job: WorkflowCronJob,
  index: number,
): void {
  const s = state();
  // Capture the generation this timer belongs to. A reload (clearAll) bumps it;
  // a timer that already fired before its clearTimeout ran would otherwise keep
  // a removed/changed cron definition alive by rescheduling itself.
  const generation = s.generation ?? 0;
  const key = jobKey(workflowId, index, job.name);
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
    // Superseded by a reload between firing and clearTimeout: do nothing so we
    // neither fire nor reschedule the stale job onto the rebuilt schedule.
    if ((state().generation ?? 0) !== generation) return;
    const reached = nextRun(spec, new Date(Date.now() - 60_000));
    const due = !reached || reached.getTime() <= Date.now() + 1000;
    const reschedule = () => {
      if ((state().generation ?? 0) === generation) {
        scheduleOne(workflowId, job, index);
      }
    };
    if (due) {
      void fire(workflowId, job).finally(reschedule);
    } else {
      reschedule();
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  s.timers.set(key, timer);
}

function clearAll(): void {
  const s = state();
  for (const timer of s.timers.values()) clearTimeout(timer);
  s.timers.clear();
  // Invalidate any timer callback already in flight (fired but not yet cleared)
  // so it can't reschedule itself after the upcoming reload rebuilds the map.
  s.generation = (s.generation ?? 0) + 1;
}

async function loadAll(): Promise<void> {
  const workflows = await db.query.workflows.findMany({
    where: (s, { eq }) => eq(s.status, 'deployed'),
  });
  for (const workflow of workflows) {
    const jobs = await cronJobsFor(workflow.id);
    jobs.forEach((job, index) => scheduleOne(workflow.id, job, index));
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
  const s = state();
  s.started = true;
  clearAll();
  try {
    await loadAll();
  } catch (error) {
    // The old timers are already cleared; a transient DB/load failure would
    // otherwise leave every cron trigger disabled with `started` stuck true so
    // ensureWorkflowScheduler() never retries. Reset it so a later boot/reload
    // rebuilds the schedule, then surface the failure to the caller.
    s.started = false;
    throw error;
  }
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
