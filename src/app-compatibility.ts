/** Compatibility version assigned to deployments recorded before this field existed. */
export const LEGACY_APP_COMPATIBILITY_VERSION = 1;

/**
 * Compatibility version produced by every new App deployment. Bump this when
 * final deployment output changes in a way that existing releases do not gain
 * until Agent redeploys them.
 */
export const LATEST_APP_COMPATIBILITY_VERSION = 2;

/**
 * Oldest compatibility version the current platform runtime can execute. Raise
 * this only when runtime support for older deployment output is removed.
 */
export const MIN_SUPPORTED_APP_COMPATIBILITY_VERSION = 1;

export type AppCompatibility = {
  version: number;
  latestVersion: number;
  minimumSupportedVersion: number;
  isSupported: boolean;
  isLatest: boolean;
};

/** Resolve legacy deployment rows without mutating or backfilling history. */
export function resolveAppCompatibilityVersion(
  version: number | null | undefined,
): number {
  return version ?? LEGACY_APP_COMPATIBILITY_VERSION;
}

/** Build the stable compatibility read model shared by server and UI code. */
export function appCompatibility(
  version: number | null | undefined,
): AppCompatibility {
  const resolved = resolveAppCompatibilityVersion(version);
  return {
    version: resolved,
    latestVersion: LATEST_APP_COMPATIBILITY_VERSION,
    minimumSupportedVersion: MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
    isSupported: resolved >= MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
    isLatest: resolved === LATEST_APP_COMPATIBILITY_VERSION,
  };
}

export const APP_COMPATIBILITY_UPDATE_MESSAGE =
  'This App cannot run on the current platform compatibility policy. Use Agent to update and redeploy it.';

export const APP_COMPATIBILITY_ROLLBACK_MESSAGE =
  'This deployment is below the minimum supported compatibility version. Use Agent to restore it, then update and redeploy the App.';
