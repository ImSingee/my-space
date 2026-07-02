import { Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { IconDownload, IconFileCode } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  BuildLogContent,
  DeploymentHistoryView,
  metaItemClass,
} from '~components/deployments/deployment-history';
import {
  workflowDeploymentBuildLogQueryOptions,
  workflowDeploymentsQueryOptions,
  workflowOpsQueryOptions,
} from '~queries/workflows';
import { rollbackWorkflowFn } from '~server/workflows';

// Fetch the (potentially large) build log only once the row is expanded.
function WorkflowBuildLog({
  workflowId,
  deploymentId,
  enabled,
}: {
  workflowId: string;
  deploymentId: string;
  enabled: boolean;
}) {
  const query = useQuery({
    ...workflowDeploymentBuildLogQueryOptions(workflowId, deploymentId),
    enabled,
  });
  return <BuildLogContent query={query} />;
}

export function WorkflowDeploymentHistory({
  workflowId,
}: {
  workflowId: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const query = useQuery(workflowDeploymentsQueryOptions(workflowId));

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackWorkflowFn({ data: { id: workflowId, deploymentId } }),
    onSuccess: (result) => {
      toast.success(`Restored v${result.version}`);
      void qc.invalidateQueries(workflowDeploymentsQueryOptions(workflowId));
      // The restored version may carry different cron jobs / webhook settings;
      // refresh the Triggers panel (separate query) so it doesn't show stale ops.
      void qc.invalidateQueries(workflowOpsQueryOptions(workflowId));
      void router.invalidate();
    },
  });

  return (
    <DeploymentHistoryView
      deployments={query.data ?? []}
      isLoading={query.isLoading}
      emptyNoun="workflow"
      onRollback={(deploymentId) => rollback.mutate(deploymentId)}
      rollingId={rollback.isPending ? (rollback.variables ?? null) : null}
      renderArtifact={(deployment) =>
        deployment.hasArtifact ? (
          <Tooltip label="Download bundle (.js)" withArrow position="top">
            <UnstyledButton
              component="a"
              href={`/api/workflows/${workflowId}/download?deployment=${deployment.id}`}
              download
              className={metaItemClass}
            >
              <IconFileCode size={13} stroke={1.6} />
              <Text size="xs">Bundle</Text>
              <IconDownload size={12} stroke={1.6} />
            </UnstyledButton>
          </Tooltip>
        ) : null
      }
      renderBuildLog={(deploymentId, open) => (
        <WorkflowBuildLog
          workflowId={workflowId}
          deploymentId={deploymentId}
          enabled={open}
        />
      )}
    />
  );
}
