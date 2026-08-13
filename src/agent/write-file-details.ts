/** Structured result emitted by a successful `write_file` call. */
export type WriteFileDetails = {
  path: string;
};

/** Safely recognize persisted or streamed write details from untrusted JSON. */
export function isWriteFileDetails(value: unknown): value is WriteFileDetails {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).path === 'string'
  );
}
