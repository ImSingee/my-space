/** Compatibility version assigned to deployments recorded before this field existed. */
export const LEGACY_APP_COMPATIBILITY_VERSION = 1;

/**
 * Compatibility version used when an existing App source manifest omits its
 * declaration. Keep this independent from latest: a future version must not
 * silently opt old source into a newer contract.
 */
export const DEFAULT_APP_COMPATIBILITY_VERSION = 2;

/**
 * Highest compatibility contract implemented by this platform. Bump this when
 * a new contract is available to App source manifests.
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

/** Resolve and validate the compatibility contract selected for a new deploy. */
export function resolveAppDeployCompatibilityVersion(
  version: number | undefined,
): number {
  const resolved = version ?? DEFAULT_APP_COMPATIBILITY_VERSION;
  if (resolved < MIN_SUPPORTED_APP_COMPATIBILITY_VERSION) {
    throw new Error(
      `manifest.json compatibilityVersion v${resolved} is below the platform ` +
        `minimum v${MIN_SUPPORTED_APP_COMPATIBILITY_VERSION}. Update the App ` +
        'source to a supported compatibility contract before deploying.',
    );
  }
  if (resolved > LATEST_APP_COMPATIBILITY_VERSION) {
    throw new Error(
      `manifest.json compatibilityVersion v${resolved} is newer than this ` +
        `platform's latest supported v${LATEST_APP_COMPATIBILITY_VERSION}. ` +
        'Deploy this source with a platform version that supports that contract.',
    );
  }
  return resolved;
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
