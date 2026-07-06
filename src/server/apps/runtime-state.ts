/**
 * Server-only: in-memory bookkeeping of app backend lifecycle facts.
 *
 * The process registry in `runtime.ts` only knows about *live* backends — an
 * entry is deleted the moment its process exits, so "when did it stop, and
 * why" has no readable source. This module keeps a per-app snapshot of the
 * most recent lifecycle facts (last spawn, last exit, last start failure,
 * auto-restart count) that survives the process's death.
 *
 * Deliberately memory-only (a `globalThis` map, like the runtime registry, so
 * dev HMR module reloads keep writing to the same state): these are runtime
 * observations about the current platform process, not durable data. A
 * platform restart clears them, which is correct — the processes they
 * described are gone too. Nothing here is ever written to the database.
 *
 * Liveness is intentionally NOT stored: whether a backend is running/starting
 * is derived from the live registry at read time (see
 * `getBackendRuntimeView` in runtime.ts), so the snapshot can never disagree
 * with the actual process table.
 */

export type BackendRuntimeSnapshot = {
  /**
   * pid of the most recently spawned process for this app. Exit events carry
   * their process's pid and are ignored unless it matches, so a straggling
   * exit from a superseded process can't clobber the facts of a newer one.
   */
  pid: number | null;
  port: number | null;
  /** When the most recent spawn happened (epoch ms). */
  startedAt: number | null;
  /** When the most recent process ended — exit, crash, or manual stop. */
  stoppedAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  /** Message of the most recent failed start; cleared by the next ready. */
  lastError: string | null;
  /** Keep-alive crashes that scheduled an automatic restart, this process run. */
  restartCount: number;
};

type StateGlobal = typeof globalThis & {
  __hatchAppRuntimeSnapshots__?: Map<string, BackendRuntimeSnapshot>;
};

function snapshots(): Map<string, BackendRuntimeSnapshot> {
  const g = globalThis as StateGlobal;
  g.__hatchAppRuntimeSnapshots__ ??= new Map<string, BackendRuntimeSnapshot>();
  return g.__hatchAppRuntimeSnapshots__;
}

function entry(id: string): BackendRuntimeSnapshot {
  const map = snapshots();
  let snap = map.get(id);
  if (!snap) {
    snap = {
      pid: null,
      port: null,
      startedAt: null,
      stoppedAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: null,
      restartCount: 0,
    };
    map.set(id, snap);
  }
  return snap;
}

/** A new backend process was spawned (not necessarily ready yet). */
export function recordBackendSpawn(
  id: string,
  info: { pid: number | null; port: number; startedAt: number },
): void {
  const snap = entry(id);
  snap.pid = info.pid;
  snap.port = info.port;
  snap.startedAt = info.startedAt;
}

/** The spawned process became ready: the previous start failure is stale. */
export function recordBackendReady(id: string, pid: number | null): void {
  const snap = snapshots().get(id);
  if (!snap || snap.pid !== pid) return;
  snap.lastError = null;
}

/**
 * A backend process exited. Applied only when `pid` matches the most recent
 * spawn, so late exits of superseded processes are ignored.
 */
export function recordBackendExit(
  id: string,
  info: {
    pid: number | null;
    code: number | null;
    signal: string | null;
  },
): void {
  const snap = snapshots().get(id);
  if (!snap || snap.pid !== info.pid) return;
  snap.stoppedAt = Date.now();
  snap.lastExitCode = info.code;
  snap.lastExitSignal = info.signal;
}

/**
 * A manual/programmatic stop killed the running process. The exit event will
 * usually land right after (matching pid) and fill in the exit signal; this
 * records the stop moment even if it never does.
 */
export function recordBackendStopped(id: string): void {
  const snap = snapshots().get(id);
  if (!snap) return;
  snap.stoppedAt = Date.now();
}

/**
 * A cold start failed (spawn error, exit before ready, or ready timeout).
 * Applied only when `pid` matches the most recent spawn: a superseded start's
 * failure (its SIGKILL from stop/restart/redeploy surfaces as a readiness
 * rejection too) must not overwrite the snapshot of the replacement process.
 */
export function recordBackendStartFailure(
  id: string,
  pid: number | null,
  message: string,
): void {
  const snap = snapshots().get(id);
  if (!snap || snap.pid !== pid) return;
  snap.lastError = message;
  // The exit event records the precise stop moment only when it fires with a
  // matching pid; a spawn error never produces one, so stamp the failure time
  // here too (an exit a few ms earlier being overwritten is harmless).
  snap.stoppedAt = Date.now();
}

/** A keep-alive crash scheduled an automatic restart. */
export function recordBackendAutoRestart(id: string): void {
  entry(id).restartCount += 1;
}

export function getBackendSnapshot(id: string): BackendRuntimeSnapshot | null {
  return snapshots().get(id) ?? null;
}

/** Test-only: drop all recorded snapshots. */
export function resetBackendRuntimeState(): void {
  snapshots().clear();
}
