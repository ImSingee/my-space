import type { DeploymentCompatibility } from '~/deployment-compatibility';

export type CompatibilityCopyOptions = {
  resourceName: 'App' | 'Workflow';
  skillName: 'app-compatibility' | 'workflow-compatibility';
};

export function compatibilityListSummary(
  compatibility: DeploymentCompatibility,
  options: CompatibilityCopyOptions,
): string {
  if (compatibility.isLatest) return '';
  if (compatibility.isSupported) {
    return ` (update available; read the \`${options.skillName}\` Skill)`;
  }
  return compatibility.version > compatibility.latestVersion
    ? ' (runtime disabled; update the platform before running this deployment)'
    : ` (runtime disabled; read the \`${options.skillName}\` Skill before updating and redeploying)`;
}

export function compatibilityDetailGuidance(
  compatibility: DeploymentCompatibility,
  options: CompatibilityCopyOptions,
): string {
  if (compatibility.isSupported) {
    return compatibility.isLatest
      ? ''
      : ` — read the \`${options.skillName}\` Skill, then redeploy to update`;
  }
  return compatibility.version > compatibility.latestVersion
    ? ' — runtime disabled; update the platform before running this deployment'
    : ` — runtime disabled; read the \`${options.skillName}\` Skill before updating and redeploying`;
}

export function compatibilityRollbackWarning(
  compatibility: DeploymentCompatibility,
  options: CompatibilityCopyOptions,
): string {
  if (!compatibility.isSupported) {
    if (compatibility.version > compatibility.latestVersion) {
      return (
        `Warning: compatibility v${compatibility.version} is newer than this ` +
        `platform's latest supported v${compatibility.latestVersion}. This ` +
        `${options.resourceName} cannot run until the platform is updated.`
      );
    }
    return (
      `Warning: compatibility v${compatibility.version} is below the platform ` +
      `minimum v${compatibility.minimumSupportedVersion}; read the ` +
      `\`${options.skillName}\` Skill. This ${options.resourceName} cannot run ` +
      'until it is updated and redeployed.'
    );
  }
  return compatibility.isLatest
    ? ''
    : `Compatibility v${compatibility.version} is older than latest v${compatibility.latestVersion}; read the \`${options.skillName}\` Skill, then redeploy to update it.`;
}
