/**
 * Server-only: in-process registry that lets an Agent `ask` tool (running inside
 * an open SSE turn) wait for the user's reply, which arrives over a separate
 * `/api/agent/answer` request. Keyed by a per-question `askId`.
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

/**
 * Wait for the user to answer the question identified by `askId`. Rejects if the
 * turn is aborted (e.g. the user navigates away or stops the stream).
 */
export function waitForAnswer(
  askId: string,
  signal?: AbortSignal,
): Promise<AskAnswer[]> {
  return new Promise<AskAnswer[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Question cancelled.'));
      return;
    }
    const onAbort = () => {
      waiters.delete(askId);
      reject(new Error('Question cancelled.'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    waiters.set(askId, {
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
export function submitAnswer(askId: string, answers: AskAnswer[]): boolean {
  const waiter = waiters.get(askId);
  if (!waiter) return false;
  waiters.delete(askId);
  waiter.resolve(answers);
  return true;
}
