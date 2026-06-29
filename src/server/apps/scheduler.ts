/** Server-only: cron scheduler that triggers app backends on schedule. */
import { db, schema } from '~/db';
import type { CronJob, NormalizedManifest } from './manifest';
import { nextRun, parseCron } from './cron-expr';
import { callAppBackend } from './runtime';

type SchedulerGlobal = typeof globalThis & {
  __hatchScheduler__?: {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    started: boolean;
    /** Bumped on every clear/reload to invalidate in-flight reschedules. */
    generation: number;
  };
};

function state() {
  const g = globalThis as SchedulerGlobal;
  g.__hatchScheduler__ ??= { timers: new Map(), started: false, generation: 0 };
  return g.__hatchScheduler__;
}

function jobKey(appId: string, jobName: string): string {
  return `${appId}::${jobName}`;
}

async function log(
  appId: string,
  level: 'info' | 'error',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(schema.logs).values({
      appId,
      source: 'cron',
      level,
      message,
      data: (data ?? null) as never,
    });
  } catch {
    /* logging is best-effort */
  }
}

/** Read cron jobs from an app's current deployment normalized manifest. */
async function cronJobsFor(appId: string): Promise<CronJob[]> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, appId),
  });
  if (
    !app ||
    app.status !== 'deployed' ||
    !app.capabilities?.cron ||
    !app.currentDeploymentId
  ) {
    return [];
  }
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return manifest?.cron ?? [];
}

async function fire(appId: string, job: CronJob): Promise<void> {
  const firedAt = new Date().toISOString();
  try {
    const res = await callAppBackend(appId, job.path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hatch-cron': job.name,
      },
      body: JSON.stringify({ job: job.name, firedAt }),
    });
    const ok = res.status >= 200 && res.status < 300;
    await log(
      appId,
      ok ? 'info' : 'error',
      `cron "${job.name}" → ${job.path} (${res.status})`,
      { status: res.status, body: res.body.slice(0, 500) },
    );
  } catch (error) {
    await log(appId, 'error', `cron "${job.name}" failed`, {
      error: (error as Error).message,
    });
  }
}

function scheduleOne(appId: string, job: CronJob): void {
  const s = state();
  // Capture the generation this timer belongs to. A clearAll()/reload bumps the
  // generation, so a fire() that was already in flight when the reload happened
  // must not re-add a timer for a job that may no longer exist.
  const gen = s.generation;
  const key = jobKey(appId, job.name);
  const existing = s.timers.get(key);
  if (existing) clearTimeout(existing);

  let spec: ReturnType<typeof parseCron>;
  try {
    spec = parseCron(job.schedule);
  } catch (error) {
    void log(appId, 'error', `invalid cron for "${job.name}"`, {
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
    if (s.generation !== gen) return;
    const reached = nextRun(spec, new Date(Date.now() - 60_000));
    const due = !reached || reached.getTime() <= Date.now() + 1000;
    if (due) {
      void fire(appId, job).finally(() => {
        if (s.generation === gen) scheduleOne(appId, job);
      });
    } else {
      scheduleOne(appId, job);
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  s.timers.set(key, timer);
}

function clearAll(): void {
  const s = state();
  // Invalidate any reschedule that a still-running fire() might attempt.
  s.generation++;
  for (const timer of s.timers.values()) clearTimeout(timer);
  s.timers.clear();
}

async function loadAll(): Promise<void> {
  const apps = await db.query.apps.findMany({
    where: (s, { eq }) => eq(s.status, 'deployed'),
  });
  for (const app of apps) {
    if (!app.capabilities?.cron) continue;
    const jobs = await cronJobsFor(app.id);
    for (const job of jobs) scheduleOne(app.id, job);
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
  const s = state();
  s.started = true;
  clearAll();
  try {
    await loadAll();
  } catch (error) {
    // Timers are already cleared; a transient DB/read failure would otherwise
    // leave every cron job unscheduled with `started` stuck true so
    // ensureScheduler() never retries (and deploy suppresses this error). Reset
    // it so a later boot/app-list load rebuilds the schedule, then surface the
    // failure to the caller.
    s.started = false;
    throw error;
  }
}

/** Manually trigger a single cron job now. */
export async function runCronJobNow(
  appId: string,
  jobName: string,
): Promise<{ status: number; body: string }> {
  const jobs = await cronJobsFor(appId);
  const job = jobs.find((j) => j.name === jobName);
  if (!job) throw new Error(`Cron job "${jobName}" not found.`);
  const res = await callAppBackend(appId, job.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatch-cron': job.name },
    body: JSON.stringify({ job: job.name, firedAt: new Date().toISOString() }),
  });
  await log(
    appId,
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

/** List an app's cron jobs with their next computed run time (for UI). */
export async function listCronJobs(appId: string): Promise<CronJobView[]> {
  const jobs = await cronJobsFor(appId);
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
