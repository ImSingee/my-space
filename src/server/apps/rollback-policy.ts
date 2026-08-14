/** Pure rollback policy shared by deployment summaries and execution guards. */

export const APP_DATABASE_ROLLBACK_BLOCKED_REASON =
  "The app database was permanently deleted. Restore this deployment tag's " +
  'files onto current master, commit them, and deploy as a new release to ' +
  'provision a new database.';

export const APP_DATA_TABLE_ROLLBACK_BLOCKED_REASON =
  'The Data Table database was permanently deleted. Restore this deployment ' +
  "tag's files onto current master, commit them, and deploy as a new release " +
  'to provision a new Data Table database.';

export const APP_DATABASES_ROLLBACK_BLOCKED_REASON =
  'The app database and Data Table database were permanently deleted. ' +
  "Restore this deployment tag's files onto current master, commit them, and " +
  'deploy as a new release to provision new databases.';

/** True only for a persisted normalized manifest that explicitly needs DB. */
export function deploymentRequiresDatabase(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (capabilities as { database?: unknown }).database === true;
}

/** True only for a persisted normalized manifest that enables Data Tables. */
export function deploymentRequiresDataTable(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return false;
  return (capabilities as { dataTable?: unknown }).dataTable === true;
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

/** Explain why a Data Table-dependent deployment cannot be restored. */
export function dataTableRollbackBlockedReason(
  dataDbName: string | null | undefined,
  dataDbPasswordCiphertext: string | null | undefined,
  manifest: unknown,
): string | null {
  return !(dataDbName && dataDbPasswordCiphertext) &&
    deploymentRequiresDataTable(manifest)
    ? APP_DATA_TABLE_ROLLBACK_BLOCKED_REASON
    : null;
}

/** Combine missing persistent resources into the single rollback wire field. */
export function deploymentRollbackBlockedReason(
  resources: {
    dbName: string | null | undefined;
    dataDbName: string | null | undefined;
    dataDbPasswordCiphertext: string | null | undefined;
  },
  manifest: unknown,
): string | null {
  const databaseReason = databaseRollbackBlockedReason(
    resources.dbName,
    manifest,
  );
  const dataTableReason = dataTableRollbackBlockedReason(
    resources.dataDbName,
    resources.dataDbPasswordCiphertext,
    manifest,
  );
  if (databaseReason && dataTableReason) {
    return APP_DATABASES_ROLLBACK_BLOCKED_REASON;
  }
  return databaseReason ?? dataTableReason;
}
