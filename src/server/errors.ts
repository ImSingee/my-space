/**
 * Server-only: structured errors for API routes and server functions.
 *
 * Server code should throw `AppError` (or a subclass) with the HTTP status the
 * failure maps to; HTTP route handlers convert any thrown value with
 * `errorResponse`. This keeps status codes out of error-message string
 * matching, where a copy tweak would silently change HTTP semantics.
 */

export class AppError extends Error {
  /** HTTP status an API route should respond with for this failure. */
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/**
 * Map a thrown value to an HTTP Response: `AppError` (and subclasses) carry
 * their own status; anything else gets `fallbackStatus` with its message.
 */
export function errorResponse(error: unknown, fallbackStatus = 400): Response {
  const status = error instanceof AppError ? error.status : fallbackStatus;
  return new Response(error instanceof Error ? error.message : String(error), {
    status,
  });
}
