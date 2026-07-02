import { Box, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { IconDownload, IconFileZip } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  BuildLogContent,
  DeploymentHistoryView,
  metaItemClass,
} from '~components/deployments/deployment-history';
import {
  appOpsQueryOptions,
  deploymentBuildLogQueryOptions,
  deploymentsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { rollbackAppFn } from '~server/apps';

// Fetch the (potentially large) build log only once the row is expanded.
function AppBuildLog({
  appId,
  deploymentId,
  enabled,
}: {
  appId: string;
  deploymentId: string;
  enabled: boolean;
}) {
  const query = useQuery({
    ...deploymentBuildLogQueryOptions(appId, deploymentId),
    enabled,
  });
  return <BuildLogContent query={query} />;
}

export function DeploymentHistory({ appId }: { appId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const query = useQuery(deploymentsQueryOptions(appId));

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackAppFn({ data: { id: appId, deploymentId } }),
    onSuccess: (result) => {
      toast.success(`Restored v${result.version}`);
      void qc.invalidateQueries(deploymentsQueryOptions(appId));
      // Rolling back can change backend/cron/webhook/storage capabilities, so
      // refresh the Operations panel on this page too; the deployments + loader
      // invalidation alone leaves its cached ops data stale.
      void qc.invalidateQueries(appOpsQueryOptions(appId));
      // The restored deployment may declare a different RPC API (proto), so
      // refresh the API panel's manifest cache as well — otherwise it keeps
      // showing the previous deployment's services/proto until a focus refetch.
      void qc.invalidateQueries(normalizedManifestQueryOptions(appId));
      void router.invalidate();
    },
  });

  return (
    <DeploymentHistoryView
      deployments={query.data ?? []}
      isLoading={query.isLoading}
      emptyNoun="app"
      onRollback={(deploymentId) => rollback.mutate(deploymentId)}
      rollingId={rollback.isPending ? (rollback.variables ?? null) : null}
      renderArtifact={(deployment) =>
        deployment.hasArtifact ? (
          <Tooltip label="Download artifact (.tar.gz)" withArrow position="top">
            <UnstyledButton
              component="a"
              href={`/api/apps/${appId}/download?mode=artifact&deployment=${deployment.id}`}
              download
              className={metaItemClass}
            >
              <IconFileZip size={13} stroke={1.6} />
              <Text size="xs">Artifact</Text>
              <IconDownload size={12} stroke={1.6} />
            </UnstyledButton>
          </Tooltip>
        ) : (
          <Box component="span" className={metaItemClass}>
            <IconFileZip size={13} stroke={1.6} />
            <Text size="xs">Artifact pruned</Text>
          </Box>
        )
      }
      renderBuildLog={(deploymentId, open) => (
        <AppBuildLog appId={appId} deploymentId={deploymentId} enabled={open} />
      )}
    />
  );
}
