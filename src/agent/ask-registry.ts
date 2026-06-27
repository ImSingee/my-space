/**
 * Server-only: in-process registry that lets an Agent `ask` tool wait for the
 * user's reply, which arrives over a separate
 * `/api/agent/runs/:runId/answer` request. Keyed by `runId` + `askId`.
 *
 * Single-process by design (matches the rest of the platform runtime). It is
 * not shared across multiple server instances.
 */
import type { AskAnswer } from './events';

type Waiter = {
  resolve: (answers: AskAnswer[]) => void;
  reject: (error: Error) => void;
};

const waiters = new Map<string, Waiter>();

function key(runId: string, askId: string): string {
  return `${runId}:${askId}`;
}

/**
 * Wait for the user to answer the question identified by `askId`. Rejects if
 * the run is explicitly cancelled or interrupted.
 */
export function waitForAnswer(
  runId: string,
  askId: string,
  signal?: AbortSignal,
): Promise<AskAnswer[]> {
  return new Promise<AskAnswer[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Question cancelled.'));
      return;
    }
    const onAbort = () => {
      waiters.delete(key(runId, askId));
      reject(new Error('Question cancelled.'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    waiters.set(key(runId, askId), {
      resolve: (answers) => {
        cleanup();
        resolve(answers);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Deliver the user's answer to a waiting `ask`. Returns false when there is no
 * matching pending question (already answered, expired, or wrong id).
 */
export function submitAnswer(
  runId: string,
  askId: string,
  answers: AskAnswer[],
): boolean {
  const waiter = waiters.get(key(runId, askId));
  if (!waiter) return false;
  waiters.delete(key(runId, askId));
  waiter.resolve(answers);
  return true;
}
