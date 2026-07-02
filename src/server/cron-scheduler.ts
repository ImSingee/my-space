/**
 * Server-only: shared cron scheduling engine.
 *
 * Apps and workflows schedule cron jobs the same way — per-job setTimeout
 * chains with capped sleeps, generation-guarded reloads, and idempotent boot.
 * This module implements that engine once; the app and workflow schedulers
 * plug in their own job loading and firing.
 *
 * Single-instance design: timers live on globalThis, keyed per scheduler, so
 * duplicate module loads (dev hot reload) attach to the same state instead of
 * double-scheduling.
 */
import { nextRun, parseCron } from '~server/apps/cron-expr';

type SchedulerState = {
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

export type CronSchedulerConfig<J> = {
  /** globalThis property holding this scheduler's state (must be unique). */
  globalKey: string;
  /**
   * Stable timer key for one job. Include the index when job names can repeat,
   * so duplicates get distinct timers instead of clobbering each other.
   */
  jobKey: (ownerId: string, job: J, index: number) => string;
  /** The job's cron expression. */
  schedule: (job: J) => string;
  /** Fire the job. Must not reject for expected failures (log/record inside). */
  fire: (ownerId: string, job: J) => Promise<void>;
  /** Optional hook when a job's cron expression fails to parse. */
  onInvalidSchedule?: (ownerId: string, job: J, error: Error) => void;
  /** Load every (ownerId, jobs) pair that should currently be scheduled. */
  loadJobs: () => Promise<{ ownerId: string; jobs: J[] }[]>;
};

/** Cap individual sleeps so very distant jobs still re-evaluate periodically. */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

export function createCronScheduler<J>(cfg: CronSchedulerConfig<J>) {
  function state(): SchedulerState {
    const g = globalThis as Record<string, unknown> & typeof globalThis;
    g[cfg.globalKey] ??= {
      timers: new Map(),
      started: false,
      generation: 0,
    } satisfies SchedulerState;
    return g[cfg.globalKey] as SchedulerState;
  }

  function scheduleOne(ownerId: string, job: J, index: number): void {
    const s = state();
    // Capture the generation this timer belongs to. A reload (clearAll) bumps
    // it; a timer that already fired before its clearTimeout ran would
    // otherwise keep a removed/changed cron definition alive by rescheduling.
    const generation = s.generation ?? 0;
    const key = cfg.jobKey(ownerId, job, index);
    const existing = s.timers.get(key);
    if (existing) clearTimeout(existing);

    let spec: ReturnType<typeof parseCron>;
    try {
      spec = parseCron(cfg.schedule(job));
    } catch (error) {
      cfg.onInvalidSchedule?.(ownerId, job, error as Error);
      return;
    }
    const next = nextRun(spec);
    if (!next) return;

    const delay = Math.min(
      Math.max(next.getTime() - Date.now(), 1000),
      MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      // Superseded by a reload between firing and clearTimeout: do nothing so
      // we neither fire nor reschedule the stale job onto the rebuilt schedule.
      if ((state().generation ?? 0) !== generation) return;
      const reached = nextRun(spec, new Date(Date.now() - 60_000));
      const due = !reached || reached.getTime() <= Date.now() + 1000;
      const reschedule = () => {
        if ((state().generation ?? 0) === generation) {
          scheduleOne(ownerId, job, index);
        }
      };
      if (due) {
        void cfg.fire(ownerId, job).finally(reschedule);
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
    // Invalidate any timer callback already in flight (fired but not yet
    // cleared) so it can't reschedule itself after the reload rebuilds the map.
    s.generation = (s.generation ?? 0) + 1;
  }

  async function loadAll(): Promise<void> {
    const owners = await cfg.loadJobs();
    for (const { ownerId, jobs } of owners) {
      jobs.forEach((job, index) => scheduleOne(ownerId, job, index));
    }
  }

  /** Start the scheduler once (idempotent). Safe to call from any entry. */
  function ensure(): void {
    const s = state();
    if (s.started) return;
    s.started = true;
    // Allow a retry if the very first load fails (e.g. called at boot before
    // the database is reachable); a later deploy/rollback or load re-runs it.
    void loadAll().catch(() => {
      s.started = false;
    });
  }

  /** Reload all schedules (call after a deploy/rollback/delete). */
  async function reload(): Promise<void> {
    const s = state();
    s.started = true;
    clearAll();
    try {
      await loadAll();
    } catch (error) {
      // The old timers are already cleared; a transient DB/load failure would
      // otherwise leave every cron job unscheduled with `started` stuck true
      // so ensure() never retries. Reset it so a later boot/reload rebuilds
      // the schedule, then surface the failure to the caller.
      s.started = false;
      throw error;
    }
  }

  return { ensure, reload };
}
