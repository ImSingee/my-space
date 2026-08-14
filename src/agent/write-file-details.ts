import { isFilePathDetails } from './file-path-details';

/** Structured result emitted by a successful `write_file` call. */
export type WriteFileDetails = {
  path: string;
  /** Added for path-aware UI; optional so historical details remain valid. */
  relativePath?: string;
  absolutePath?: string;
};

/** Safely recognize persisted or streamed write details from untrusted JSON. */
export function isWriteFileDetails(value: unknown): value is WriteFileDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  const hasNoPathPair =
    details.relativePath === undefined && details.absolutePath === undefined;
  const hasCompletePathPair = isFilePathDetails(value);
  return (
    typeof details.path === 'string' && (hasNoPathPair || hasCompletePathPair)
  );
}
