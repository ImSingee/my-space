/**
 * Server-only: shared deploy serialization used by app and workflow releases.
 *
 * Deploys (and rollbacks, which share the lock) are serialized at two levels:
 *
 * 1. In-process: a per-id promise chain so two concurrent calls in the same
 *    server process run strictly one after the other.
 * 2. Cross-process: a PostgreSQL advisory lock (namespaced per entity kind)
 *    held for the version → tag → record transaction, so deploys from other
 *    server processes can't allocate the same version or force-move the same
 *    deploy/v<n> tag onto different commits.
 */
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { WORKSPACE_ROOT } from '~agent/paths';
import type { TX } from '~/db/db';

/** Store workspace paths relative + POSIX-style so the DB rows stay portable. */
export function workspaceRelative(p: string): string {
  return path.relative(WORKSPACE_ROOT, p).split(path.sep).join('/');
}

export type DeployLock = {
  /** Advisory-lock namespace (first arg to pg_advisory_xact_lock). */
  ns: number;
  /**
   * Run `fn` only after any in-flight deploy (or rollback) for the same id has
   * settled. Chains regardless of the previous outcome — a failed deploy must
   * not wedge later attempts for the same id.
   */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Take the per-id advisory lock inside `tx` (held until commit/rollback).
   * Serializes the critical section against other server processes.
   */
  acquire(tx: TX, id: string): Promise<void>;
};

export function createDeployLock(ns: number): DeployLock {
  const chains = new Map<string, Promise<unknown>>();
  return {
    ns,
    withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(id) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const tail = run.catch(() => {});
      chains.set(id, tail);
      void tail.finally(() => {
        if (chains.get(id) === tail) chains.delete(id);
      });
      return run;
    },
    async acquire(tx: TX, id: string): Promise<void> {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ns}, hashtext(${id}))`,
      );
    },
  };
}
