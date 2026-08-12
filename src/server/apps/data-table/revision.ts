import { AppError } from '~server/errors';

/** Parse a PostgreSQL bigint revision without accepting lossy JS numbers. */
export function parseDataRevision(value: unknown): number {
  const revision =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' ||
          (typeof value === 'string' && /^\d+$/.test(value))
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AppError('Data Table revision exceeds the supported range.', 500);
  }
  return revision;
}
