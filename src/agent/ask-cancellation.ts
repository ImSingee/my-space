/** Messages retained in tool results when an unanswered ask is cancelled. */
export const USER_CANCELLED_ASK_MESSAGE = 'The user canceled this question.';

/** Legacy results do not identify who initiated the cancellation. */
export function askCancellationMessage(value: string): string | undefined {
  const message = value.trim();
  if (message === USER_CANCELLED_ASK_MESSAGE) return message;
  if (message === 'Question cancelled.' || message === 'Question canceled.') {
    return 'This question was canceled.';
  }
  return undefined;
}
