import {
  compatibilityBelowMinimumRollbackMessage,
  compatibilityRollbackMessage,
  compatibilityRuntimeMessage,
  compatibilityUpdateMessage,
  deploymentCompatibility,
  type DeploymentCompatibility,
  validateDeployCompatibilityVersion,
} from './deployment-compatibility';

/** Highest compatibility contract implemented by this platform for Workflows. */
export const LATEST_WORKFLOW_COMPATIBILITY_VERSION = 1;

/** Oldest compatibility contract the current Workflow runtime can execute. */
export const MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION = 1;

export type WorkflowCompatibility = DeploymentCompatibility;

const WORKFLOW_COMPATIBILITY_POLICY = {
  resourceName: 'Workflow',
  latestVersion: LATEST_WORKFLOW_COMPATIBILITY_VERSION,
  minimumSupportedVersion: MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION,
} as const;

/** Validate the compatibility contract selected by a Workflow source manifest. */
export function resolveWorkflowDeployCompatibilityVersion(
  version: number,
): number {
  return validateDeployCompatibilityVersion(
    version,
    WORKFLOW_COMPATIBILITY_POLICY,
  );
}

/** Build the stable compatibility read model shared by server and UI code. */
export function workflowCompatibility(version: number): WorkflowCompatibility {
  return deploymentCompatibility(version, WORKFLOW_COMPATIBILITY_POLICY);
}

export const WORKFLOW_COMPATIBILITY_UPDATE_MESSAGE =
  compatibilityUpdateMessage('Workflow');

export const WORKFLOW_COMPATIBILITY_ROLLBACK_MESSAGE =
  compatibilityBelowMinimumRollbackMessage('Workflow');

/** Actionable runtime guidance for either side of the supported range. */
export function workflowCompatibilityRuntimeMessage(
  compatibility: WorkflowCompatibility | null | undefined,
): string {
  return compatibilityRuntimeMessage('Workflow', compatibility);
}

/** Recovery guidance for an ordinary rollback outside the supported range. */
export function workflowCompatibilityRollbackMessage(
  compatibility: WorkflowCompatibility,
): string {
  return compatibilityRollbackMessage('Workflow', compatibility);
}
