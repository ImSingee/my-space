/** Pure rollback policy shared by deployment summaries and execution guards. */

export const APP_DATABASE_ROLLBACK_BLOCKED_REASON =
  "The app database was permanently deleted. Restore this deployment tag's " +
  'files onto current master, commit them, and deploy as a new release to ' +
  'provision a new database.';

/** True only for a persisted normalized manifest that explicitly needs DB. */
export function deploymentRequiresDatabase(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (capabilities as { database?: unknown }).database === true;
}

/** Explain the destructive-resource condition that makes rollback unsafe. */
export function databaseRollbackBlockedReason(
  dbName: string | null | undefined,
  manifest: unknown,
): string | null {
  return !dbName && deploymentRequiresDatabase(manifest)
    ? APP_DATABASE_ROLLBACK_BLOCKED_REASON
    : null;
}
