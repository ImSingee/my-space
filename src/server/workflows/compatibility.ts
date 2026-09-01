/** Server-only helpers for enforcing the Workflow runtime compatibility boundary. */
import {
  type WorkflowCompatibility,
  workflowCompatibility,
  workflowCompatibilityRuntimeMessage,
} from '~/workflow-compatibility';
import { AppError } from '~server/errors';

/** A confirmed deployment state that cannot enter the current Workflow runtime. */
export class WorkflowDeploymentCompatibilityError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}

export function assertSupportedWorkflowCompatibility(
  version: number,
): WorkflowCompatibility {
  const compatibility = workflowCompatibility(version);
  if (!compatibility.isSupported) {
    throw new WorkflowDeploymentCompatibilityError(
      workflowCompatibilityRuntimeMessage(compatibility),
    );
  }
  return compatibility;
}
