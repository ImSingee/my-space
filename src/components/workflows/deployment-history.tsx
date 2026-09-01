import { Badge, Button, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { IconDownload, IconFileCode, IconRobot } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  BuildLogContent,
  DeploymentHistoryView,
  metaItemClass,
} from '~components/deployments/deployment-history';
import { requiresAgentRollback } from '~components/deployments/deployment-history-policy';
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
      renderVersionMeta={(deployment) =>
        deployment.compatibility.isLatest ? null : (
          <Badge size="xs" variant="light" color="orange">
            Compatibility v{deployment.compatibility.version}
          </Badge>
        )
      }
      renderRollbackAction={(deployment, defaultAction) => {
        if (!requiresAgentRollback(deployment)) return defaultAction;
        const requiresNewerPlatform =
          deployment.compatibility.version >
          deployment.compatibility.latestVersion;
        return (
          <Tooltip
            label={
              requiresNewerPlatform
                ? 'Only Agent can restore a deployment newer than this platform; its runtime stays disabled until the platform is updated'
                : 'Only Agent can restore a deployment below the minimum supported compatibility version'
            }
            withArrow
          >
            <Button
              size="compact-sm"
              variant="light"
              color="orange"
              leftSection={<IconRobot size={14} />}
              renderRoot={(props) => (
                <Link
                  to="/agent"
                  search={{
                    prompt: requiresNewerPlatform
                      ? `Restore Workflow ${workflowId} to v${deployment.version}. Its compatibility is newer than this platform, so keep its runtime disabled until the platform is updated.`
                      : `Restore Workflow ${workflowId} to v${deployment.version}, then update and redeploy it for the latest platform compatibility.`,
                  }}
                  {...props}
                />
              )}
            >
              Use Agent
            </Button>
          </Tooltip>
        );
      }}
      renderArtifact={(deployment) =>
        deployment.hasArtifact ? (
          <Tooltip label="Download bundle (.js)" withArrow position="top">
            <UnstyledButton
              component="a"
              href={`/api/workflow/${workflowId}/download?deployment=${deployment.id}`}
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
