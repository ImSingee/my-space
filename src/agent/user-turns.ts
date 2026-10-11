/**
 * User turns bind Agent runs to the transcript.
 *
 * A run records the zero-based position of the user message that started it
 * among the transcript's `role: 'user'` messages. The platform writes it when
 * the run is created (in the same transaction that appends that message), and
 * the chat UI counts user messages the same way to pair each reply with the
 * run that produced it. A Retry re-appends the failed turn's user message at
 * the same position, so the newest run for a user turn is the one shown.
 */
export function isUserTurnMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { role?: unknown }).role === 'user'
  );
}

/** The user turn a run gets when its user message is appended to `messages`. */
export function nextUserTurn(messages: readonly unknown[]): number {
  return messages.filter(isUserTurnMessage).length;
}

/**
 * Parse a persisted user turn (a JSON number, possibly read back as text).
 * Anything else means the run predates the binding and has no reliable turn.
 */
export function parseUserTurn(value: unknown): number | null {
  const turn =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0
    ? turn
    : null;
}
