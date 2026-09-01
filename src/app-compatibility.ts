import {
  compatibilityBelowMinimumRollbackMessage,
  compatibilityRollbackMessage,
  compatibilityRuntimeMessage,
  compatibilityUpdateMessage,
  deploymentCompatibility,
  type DeploymentCompatibility,
  validateDeployCompatibilityVersion,
} from './deployment-compatibility';

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

export type AppCompatibility = DeploymentCompatibility;

const APP_COMPATIBILITY_POLICY = {
  resourceName: 'App',
  latestVersion: LATEST_APP_COMPATIBILITY_VERSION,
  minimumSupportedVersion: MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
} as const;

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
  return validateDeployCompatibilityVersion(resolved, APP_COMPATIBILITY_POLICY);
}

/** Build the stable compatibility read model shared by server and UI code. */
export function appCompatibility(
  version: number | null | undefined,
): AppCompatibility {
  return deploymentCompatibility(
    resolveAppCompatibilityVersion(version),
    APP_COMPATIBILITY_POLICY,
  );
}

export const APP_COMPATIBILITY_UPDATE_MESSAGE =
  compatibilityUpdateMessage('App');

export const APP_COMPATIBILITY_ROLLBACK_MESSAGE =
  compatibilityBelowMinimumRollbackMessage('App');

/** Actionable runtime guidance for either side of the supported range. */
export function appCompatibilityRuntimeMessage(
  compatibility: AppCompatibility | null | undefined,
): string {
  return compatibilityRuntimeMessage('App', compatibility);
}

/** Recovery guidance for an ordinary rollback outside the supported range. */
export function appCompatibilityRollbackMessage(
  compatibility: AppCompatibility,
): string {
  return compatibilityRollbackMessage('App', compatibility);
}
