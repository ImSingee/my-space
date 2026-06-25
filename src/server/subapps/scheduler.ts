/** Server-only: cron scheduler that triggers subapp backends on schedule. */
import { db, schema } from '~/db';
import type { CronJob, NormalizedManifest } from './manifest';
import { nextRun, parseCron } from './cron-expr';
import { callSubappBackend } from './runtime';

type SchedulerGlobal = typeof globalThis & {
  __hatchScheduler__?: {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    started: boolean;
  };
};

function state() {
  const g = globalThis as SchedulerGlobal;
  g.__hatchScheduler__ ??= { timers: new Map(), started: false };
  return g.__hatchScheduler__;
}

function jobKey(subappId: string, jobName: string): string {
  return `${subappId}::${jobName}`;
}

async function log(
  subappId: string,
  level: 'info' | 'error',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.logs).values({
      subappId,
      source: 'cron',
      level,
      message,
      data: (data ?? null) as never,
    });
  } catch {
    /* logging is best-effort */
  }
}

/** Read cron jobs from a subapp's current deployment normalized manifest. */
async function cronJobsFor(subappId: string): Promise<CronJob[]> {
  const subapp = await db.query.subapps.findFirst({
    where: (s, { eq }) => eq(s.id, subappId),
  });
  if (
    !subapp ||
    subapp.status !== 'deployed' ||
    !subapp.capabilities?.cron ||
    !subapp.currentDeploymentId
  ) {
    return [];
  }
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, subapp.currentDeploymentId as string),
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return manifest?.cron ?? [];
}

async function fire(subappId: string, job: CronJob): Promise<void> {
  const firedAt = new Date().toISOString();
  try {
    const res = await callSubappBackend(subappId, job.path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hatch-cron': job.name,
      },
      body: JSON.stringify({ job: job.name, firedAt }),
    });
    const ok = res.status >= 200 && res.status < 300;
    await log(
      subappId,
      ok ? 'info' : 'error',
      `cron "${job.name}" → ${job.path} (${res.status})`,
      { status: res.status, body: res.body.slice(0, 500) },
    );
  } catch (error) {
    await log(subappId, 'error', `cron "${job.name}" failed`, {
      error: (error as Error).message,
    });
  }
}

function scheduleOne(subappId: string, job: CronJob): void {
  const s = state();
  const key = jobKey(subappId, job.name);
  const existing = s.timers.get(key);
  if (existing) clearTimeout(existing);

  let spec: ReturnType<typeof parseCron>;
  try {
    spec = parseCron(job.schedule);
  } catch (error) {
    void log(subappId, 'error', `invalid cron for "${job.name}"`, {
      schedule: job.schedule,
      error: (error as Error).message,
    });
    return;
  }
  const next = nextRun(spec);
  if (!next) return;

  // Cap individual sleeps so very distant jobs still re-evaluate periodically.
  const maxDelay = 6 * 60 * 60 * 1000;
  const delay = Math.min(Math.max(next.getTime() - Date.now(), 1000), maxDelay);
  const timer = setTimeout(() => {
    const reached = nextRun(spec, new Date(Date.now() - 60_000));
    const due = !reached || reached.getTime() <= Date.now() + 1000;
    if (due) {
      void fire(subappId, job).finally(() => scheduleOne(subappId, job));
    } else {
      scheduleOne(subappId, job);
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
  const subapps = await db.query.subapps.findMany({
    where: (s, { eq }) => eq(s.status, 'deployed'),
  });
  for (const subapp of subapps) {
    if (!subapp.capabilities?.cron) continue;
    const jobs = await cronJobsFor(subapp.id);
    for (const job of jobs) scheduleOne(subapp.id, job);
  }
}

/** Start the scheduler once (idempotent). Safe to call from any server entry. */
export function ensureScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  void loadAll();
}

/** Reload all schedules (call after a deploy/rollback/delete). */
export async function reloadScheduler(): Promise<void> {
  state().started = true;
  clearAll();
  await loadAll();
}

/** Manually trigger a single cron job now. */
export async function runCronJobNow(
  subappId: string,
  jobName: string,
): Promise<{ status: number; body: string }> {
  const jobs = await cronJobsFor(subappId);
  const job = jobs.find((j) => j.name === jobName);
  if (!job) throw new Error(`Cron job "${jobName}" not found.`);
  const res = await callSubappBackend(subappId, job.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatch-cron': job.name },
    body: JSON.stringify({ job: job.name, firedAt: new Date().toISOString() }),
  });
  await log(
    subappId,
    res.status >= 200 && res.status < 300 ? 'info' : 'error',
    `cron "${job.name}" run manually (${res.status})`,
    { status: res.status },
  );
  return res;
}

export type CronJobView = {
  name: string;
  schedule: string;
  path: string;
  nextRun: string | null;
};

/** List a subapp's cron jobs with their next computed run time (for UI). */
export async function listCronJobs(subappId: string): Promise<CronJobView[]> {
  const jobs = await cronJobsFor(subappId);
  return jobs.map((job) => {
    let next: string | null = null;
    try {
      next = nextRun(parseCron(job.schedule))?.toISOString() ?? null;
    } catch {
      next = null;
    }
    return {
      name: job.name,
      schedule: job.schedule,
      path: job.path,
      nextRun: next,
    };
  });
}
