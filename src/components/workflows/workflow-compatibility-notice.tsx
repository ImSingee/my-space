import type { WorkflowCompatibility } from '~/workflow-compatibility';
import { CompatibilityNotice } from '~components/deployments/compatibility-notice';

export function WorkflowCompatibilityNotice({
  compatibility,
}: {
  compatibility: WorkflowCompatibility | null;
}) {
  return (
    <CompatibilityNotice
      resourceName="Workflow"
      compatibility={compatibility}
    />
  );
}
