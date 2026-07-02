/** Server-only: cron scheduler that triggers app backends on schedule. */
import { db, schema } from '~/db';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '../secrets';
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

/**
 * Persist one structured cron-run record for the app's trigger-history panel.
 * Best-effort: a history write must never break (or fail) the actual cron call.
 */
async function recordCronRun(
  appId: string,
  jobName: string,
  trigger: 'scheduled' | 'manual',
  result: {
    status: number | null;
    ok: boolean;
    target: string | null;
    detail: string | null;
    durationMs: number;
  },
): Promise<void> {
  try {
    await db.insert(schema.appCronRuns).values({
      appId,
      jobName,
      trigger,
      status: result.status,
      ok: result.ok,
      target: result.target,
      detail: result.detail ? result.detail.slice(0, 1000) : null,
      durationMs: result.durationMs,
    });
  } catch {
    /* history is best-effort */
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

/**
 * Resolve what the platform needs to invoke an app's cron target: the deployed
 * RPC service name (for `method` jobs) and the per-app signing secret used to
 * sign the call. Read fresh at fire time so a redeploy is picked up.
 */
async function cronInvokeContext(
  appId: string,
): Promise<{ service?: string; signingSecret?: string }> {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.id, appId),
    columns: { signingSecret: true, currentDeploymentId: true },
  });
  if (!app?.currentDeploymentId) return {};
  const deployment = await db.query.deployments.findFirst({
    where: (d, { eq }) => eq(d.id, app.currentDeploymentId as string),
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return {
    service: manifest?.rpc?.service,
    signingSecret: app.signingSecret ?? undefined,
  };
}

/**
 * Invoke a cron job's target. Preferred `method` jobs call the app's declared
 * Connect RPC method with an empty request; legacy `path` jobs POST the raw
 * path with a small JSON payload. Both carry an HMAC signature (over the job
 * name + timestamp) so the backend can verify the call came from the platform.
 */
async function invokeCron(
  appId: string,
  job: CronJob,
): Promise<{ status: number; body: string; target: string }> {
  const firedAt = new Date().toISOString();
  const timestamp = String(Date.now());
  const { service, signingSecret } = await cronInvokeContext(appId);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-hatch-cron': job.name,
    [HATCH_TIMESTAMP_HEADER]: timestamp,
  };
  // Sign the job name; the backend reconstructs it from the x-hatch-cron header.
  if (signingSecret) {
    headers[HATCH_SIGNATURE_HEADER] = hatchSignature(
      signingSecret,
      timestamp,
      job.name,
    );
  }

  let target: string;
  let body: string;
  if (job.method) {
    if (!service) {
      throw new Error(
        `app has no deployed RPC service to call method "${job.method}"`,
      );
    }
    // Connect unary over JSON: POST /<fully-qualified-service>/<method> with an
    // empty request. Cron handlers read metadata from the x-hatch-* headers.
    target = `/${service}/${job.method}`;
    headers['connect-protocol-version'] = '1';
    body = '{}';
  } else {
    target = job.path as string;
    body = JSON.stringify({ job: job.name, firedAt });
  }

  const res = await callAppBackend(appId, target, {
    method: 'POST',
    headers,
    body,
  });
  return { ...res, target };
}

async function fire(appId: string, job: CronJob): Promise<void> {
  const startedAt = Date.now();
  try {
    const res = await invokeCron(appId, job);
    const ok = res.status >= 200 && res.status < 300;
    await recordCronRun(appId, job.name, 'scheduled', {
      status: res.status,
      ok,
      target: res.target,
      detail: res.body,
      durationMs: Date.now() - startedAt,
    });
    await log(
      appId,
      ok ? 'info' : 'error',
      `cron "${job.name}" → ${res.target} (${res.status})`,
      { status: res.status, body: res.body.slice(0, 500) },
    );
  } catch (error) {
    await recordCronRun(appId, job.name, 'scheduled', {
      status: null,
      ok: false,
      target: null,
      detail: (error as Error).message,
      durationMs: Date.now() - startedAt,
    });
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
  // Allow a retry if the very first load fails (e.g. called at boot before the
  // database is reachable); a later deploy/rollback or app-list load re-runs it.
  void loadAll().catch(() => {
    s.started = false;
  });
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
  const startedAt = Date.now();
  try {
    const res = await invokeCron(appId, job);
    const ok = res.status >= 200 && res.status < 300;
    await recordCronRun(appId, job.name, 'manual', {
      status: res.status,
      ok,
      target: res.target,
      detail: res.body,
      durationMs: Date.now() - startedAt,
    });
    await log(
      appId,
      ok ? 'info' : 'error',
      `cron "${job.name}" run manually (${res.status})`,
      { status: res.status },
    );
    return { status: res.status, body: res.body };
  } catch (error) {
    await recordCronRun(appId, job.name, 'manual', {
      status: null,
      ok: false,
      target: null,
      detail: (error as Error).message,
      durationMs: Date.now() - startedAt,
    });
    await log(appId, 'error', `cron "${job.name}" manual run failed`, {
      error: (error as Error).message,
    });
    throw error;
  }
}

export type AppCronRunView = {
  id: string;
  jobName: string;
  trigger: 'scheduled' | 'manual';
  /** HTTP status the backend returned, or null if the call threw first. */
  status: number | null;
  ok: boolean;
  target: string | null;
  detail: string | null;
  durationMs: number | null;
  createdAt: string;
};

/** List an app's recent cron runs (newest first) for the trigger-history panel. */
export async function listCronRuns(
  appId: string,
  limit = 50,
): Promise<AppCronRunView[]> {
  const rows = await db.query.appCronRuns.findMany({
    where: (r, { eq }) => eq(r.appId, appId),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    jobName: r.jobName,
    trigger: r.trigger,
    status: r.status,
    ok: r.ok,
    target: r.target,
    detail: r.detail,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type CronJobView = {
  name: string;
  schedule: string;
  /** RPC method invoked on schedule (new-style jobs), else null. */
  method: string | null;
  /** Legacy raw backend path POSTed on schedule, else null. */
  path: string | null;
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
      method: job.method ?? null,
      path: job.path ?? null,
      nextRun: next,
    };
  });
}
