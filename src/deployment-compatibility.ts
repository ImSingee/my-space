/** Compatibility state shared by immutable App and Workflow deployments. */
export type DeploymentCompatibility = {
  version: number;
  latestVersion: number;
  minimumSupportedVersion: number;
  isSupported: boolean;
  isLatest: boolean;
};

export type DeploymentCompatibilityPolicy = {
  resourceName: 'App' | 'Workflow';
  latestVersion: number;
  minimumSupportedVersion: number;
};

/** Validate a compatibility contract selected for a new deployment. */
export function validateDeployCompatibilityVersion(
  version: number,
  policy: DeploymentCompatibilityPolicy,
): number {
  if (version < policy.minimumSupportedVersion) {
    throw new Error(
      `manifest.json compatibilityVersion v${version} is below the platform ` +
        `minimum v${policy.minimumSupportedVersion}. Update the ` +
        `${policy.resourceName} source to a supported compatibility contract ` +
        'before deploying.',
    );
  }
  if (version > policy.latestVersion) {
    throw new Error(
      `manifest.json compatibilityVersion v${version} is newer than this ` +
        `platform's latest supported v${policy.latestVersion}. Deploy this ` +
        'source with a platform version that supports that contract.',
    );
  }
  return version;
}

/** Build the stable compatibility read model shared by server and UI code. */
export function deploymentCompatibility(
  version: number,
  policy: Pick<
    DeploymentCompatibilityPolicy,
    'latestVersion' | 'minimumSupportedVersion'
  >,
): DeploymentCompatibility {
  return {
    version,
    latestVersion: policy.latestVersion,
    minimumSupportedVersion: policy.minimumSupportedVersion,
    isSupported:
      version >= policy.minimumSupportedVersion &&
      version <= policy.latestVersion,
    isLatest: version === policy.latestVersion,
  };
}

export function compatibilityUpdateMessage(
  resourceName: DeploymentCompatibilityPolicy['resourceName'],
): string {
  return `This ${resourceName} cannot run on the current platform compatibility policy. Use Agent to update and redeploy it.`;
}

export function compatibilityBelowMinimumRollbackMessage(
  resourceName: DeploymentCompatibilityPolicy['resourceName'],
): string {
  return `This deployment is below the minimum supported compatibility version. Use Agent to restore it, then update and redeploy the ${resourceName}.`;
}

/** Actionable runtime guidance for either side of the supported range. */
export function compatibilityRuntimeMessage(
  resourceName: DeploymentCompatibilityPolicy['resourceName'],
  compatibility: DeploymentCompatibility | null | undefined,
): string {
  if (compatibility && compatibility.version > compatibility.latestVersion) {
    return (
      `This ${resourceName} cannot run because deployment compatibility ` +
      `v${compatibility.version} is newer than this platform's latest ` +
      `supported v${compatibility.latestVersion}. Update the platform before ` +
      'running it.'
    );
  }
  return compatibilityUpdateMessage(resourceName);
}

/** Recovery guidance for an ordinary rollback outside the supported range. */
export function compatibilityRollbackMessage(
  resourceName: DeploymentCompatibilityPolicy['resourceName'],
  compatibility: DeploymentCompatibility,
): string {
  if (compatibility.version > compatibility.latestVersion) {
    return (
      `This deployment uses compatibility v${compatibility.version}, newer ` +
      `than this platform's latest supported v${compatibility.latestVersion}. ` +
      'Update the platform before restoring it.'
    );
  }
  return compatibilityBelowMinimumRollbackMessage(resourceName);
}
