/** Structured result emitted by a successful `edit_file` call. */
export type EditFileDetails = {
  path: string;
  replacements: number;
  /** Display-oriented diff with line numbers and limited context. */
  diff: string;
  /** Standard unified patch for machine-readable consumers. */
  patch?: string;
  /** First changed line in the new file, when one exists. */
  firstChangedLine?: number;
  /** The display diff was shortened to stay within the result-size budget. */
  diffTruncated?: boolean;
  /** The unified patch was too large to include without exceeding the budget. */
  patchOmitted?: boolean;
};

/** Safely recognize persisted or streamed edit details from untrusted JSON. */
export function isEditFileDetails(value: unknown): value is EditFileDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  const firstChangedLine = details.firstChangedLine;
  const patch = details.patch;
  const patchOmitted = details.patchOmitted;
  return (
    typeof details.path === 'string' &&
    Number.isInteger(details.replacements) &&
    (details.replacements as number) > 0 &&
    typeof details.diff === 'string' &&
    (typeof patch === 'string'
      ? patchOmitted !== true
      : patch === undefined && patchOmitted === true) &&
    (details.diffTruncated === undefined ||
      typeof details.diffTruncated === 'boolean') &&
    (patchOmitted === undefined || typeof patchOmitted === 'boolean') &&
    (firstChangedLine === undefined ||
      (Number.isInteger(firstChangedLine) && (firstChangedLine as number) >= 1))
  );
}
