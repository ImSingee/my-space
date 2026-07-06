import { beforeEach, describe, expect, it } from 'vitest';
import {
  getBackendSnapshot,
  recordBackendAutoRestart,
  recordBackendExit,
  recordBackendReady,
  recordBackendSpawn,
  recordBackendStartFailure,
  recordBackendStopped,
  resetBackendRuntimeState,
} from './runtime-state';

beforeEach(() => {
  resetBackendRuntimeState();
});

describe('backend runtime snapshots', () => {
  it('has no snapshot for a backend that never started', () => {
    expect(getBackendSnapshot('never-started')).toBeNull();
  });

  it('records spawn facts and clears a stale error once ready', () => {
    recordBackendSpawn('a1', { pid: 90, port: 4000, startedAt: 500 });
    recordBackendStartFailure('a1', 90, 'boot failed');
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });

    let snap = getBackendSnapshot('a1');
    expect(snap).toMatchObject({
      pid: 100,
      port: 4001,
      startedAt: 1000,
      lastError: 'boot failed',
    });

    recordBackendReady('a1', 100);
    snap = getBackendSnapshot('a1');
    expect(snap?.lastError).toBeNull();
  });

  it('ignores a ready signal from a superseded process', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    recordBackendStartFailure('a1', 100, 'boot failed');
    recordBackendSpawn('a1', { pid: 200, port: 4002, startedAt: 2000 });

    recordBackendReady('a1', 100);
    expect(getBackendSnapshot('a1')?.lastError).toBe('boot failed');
  });

  it('records exit code/signal only for the most recent process', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    recordBackendExit('a1', { pid: 100, code: 1, signal: null });

    let snap = getBackendSnapshot('a1');
    expect(snap?.lastExitCode).toBe(1);
    expect(snap?.lastExitSignal).toBeNull();
    expect(snap?.stoppedAt).not.toBeNull();

    // A newer process spawns; the old one's late exit must not clobber it.
    recordBackendSpawn('a1', { pid: 200, port: 4002, startedAt: 2000 });
    recordBackendExit('a1', { pid: 100, code: 137, signal: 'SIGKILL' });
    snap = getBackendSnapshot('a1');
    expect(snap?.lastExitCode).toBe(1);

    recordBackendExit('a1', { pid: 200, code: null, signal: 'SIGKILL' });
    snap = getBackendSnapshot('a1');
    expect(snap?.lastExitCode).toBeNull();
    expect(snap?.lastExitSignal).toBe('SIGKILL');
  });

  it('records a manual stop moment', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    expect(getBackendSnapshot('a1')?.stoppedAt).toBeNull();

    recordBackendStopped('a1');
    expect(getBackendSnapshot('a1')?.stoppedAt).not.toBeNull();
  });

  it('stopping an app that never started records nothing', () => {
    recordBackendStopped('missing');
    expect(getBackendSnapshot('missing')).toBeNull();
  });

  it('records a start failure with its own stop moment', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    recordBackendStartFailure('a1', 100, 'deno not found');

    const snap = getBackendSnapshot('a1');
    expect(snap?.lastError).toBe('deno not found');
    expect(snap?.stoppedAt).not.toBeNull();
  });

  it('ignores a superseded start failure once a newer process spawned', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    recordBackendSpawn('a1', { pid: 200, port: 4002, startedAt: 2000 });
    recordBackendReady('a1', 200);

    // The old boot's SIGKILL surfaces as a readiness failure after the
    // replacement is already live; it must not dirty the healthy snapshot.
    recordBackendStartFailure('a1', 100, 'killed during restart');

    const snap = getBackendSnapshot('a1');
    expect(snap?.lastError).toBeNull();
    expect(snap?.stoppedAt).toBeNull();
  });

  it('counts keep-alive auto-restarts', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    expect(getBackendSnapshot('a1')?.restartCount).toBe(0);

    recordBackendAutoRestart('a1');
    recordBackendAutoRestart('a1');
    expect(getBackendSnapshot('a1')?.restartCount).toBe(2);
  });

  it('keeps exit history across a successful restart', () => {
    recordBackendSpawn('a1', { pid: 100, port: 4001, startedAt: 1000 });
    recordBackendExit('a1', { pid: 100, code: 0, signal: null });

    recordBackendSpawn('a1', { pid: 200, port: 4002, startedAt: 2000 });
    recordBackendReady('a1', 200);

    const snap = getBackendSnapshot('a1');
    // The new run is live, but the previous exit stays visible as history.
    expect(snap?.startedAt).toBe(2000);
    expect(snap?.stoppedAt).not.toBeNull();
    expect(snap?.lastExitCode).toBe(0);
  });
});
