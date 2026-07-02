import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconFileCode,
  IconGitCommit,
  IconLoader,
  IconRestore,
  IconTag,
  IconX,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { formatRelative } from '~lib/format';
import {
  workflowDeploymentBuildLogQueryOptions,
  workflowDeploymentsQueryOptions,
  workflowOpsQueryOptions,
} from '~queries/workflows';
import { rollbackWorkflowFn } from '~server/workflows';
import type { WorkflowDeploymentSummary } from '~server/workflows/manage';
import classes from '~components/apps/deployment-history.module.css';

const STATUS_META: Record<
  WorkflowDeploymentSummary['status'],
  { color: string; label: string; icon: ReactNode }
> = {
  building: {
    color: 'ember',
    label: 'Building',
    icon: <IconLoader size={11} stroke={2.5} />,
  },
  deployed: {
    color: 'ember',
    label: 'Deployed',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    color: 'red',
    label: 'Failed',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

const shortSha = (sha: string) => sha.slice(0, 7);

function MetaDot() {
  return (
    <Text span size="xs" className={classes.metaDot}>
      ·
    </Text>
  );
}

function DeploymentItem({
  workflowId,
  deployment,
  onRollback,
  rolling,
}: {
  workflowId: string;
  deployment: WorkflowDeploymentSummary;
  onRollback: (deploymentId: string) => void;
  rolling: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  const hasLog = Boolean(deployment.error) || deployment.hasBuildLog;
  const logQuery = useQuery({
    ...workflowDeploymentBuildLogQueryOptions(workflowId, deployment.id),
    enabled: open && deployment.hasBuildLog,
  });

  const body = (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={700} size="sm" className={classes.version}>
            v{deployment.version}
          </Text>
          {deployment.isCurrent ? (
            <Badge size="xs" variant="filled" radius="sm" color="ember">
              Live
            </Badge>
          ) : null}
          {deployment.status !== 'deployed' ? (
            <Text size="xs" c="dimmed">
              {STATUS_META[deployment.status].label}
            </Text>
          ) : null}
          <MetaDot />
          <Text size="xs" c="dimmed" truncate>
            {formatRelative(deployment.createdAt)}
          </Text>
        </Group>
        {deployment.canRollback ? (
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconRestore size={14} />}
            loading={rolling}
            onClick={() => onRollback(deployment.id)}
          >
            Restore
          </Button>
        ) : null}
      </Group>

      {deployment.sourceCommit ||
      deployment.sourceTag ||
      deployment.status === 'deployed' ? (
        <Group gap="sm" wrap="wrap">
          {deployment.sourceTag ? (
            <Box component="span" className={classes.metaItem}>
              <IconTag size={13} stroke={1.6} />
              <Text size="xs" ff="monospace">
                {deployment.sourceTag}
              </Text>
            </Box>
          ) : null}
          {deployment.sourceCommit ? (
            <>
              {deployment.sourceTag ? <MetaDot /> : null}
              <Tooltip label="Copy commit SHA" withArrow position="top">
                <UnstyledButton
                  type="button"
                  className={classes.metaItem}
                  onClick={() => {
                    if (!deployment.sourceCommit) return;
                    copy(deployment.sourceCommit);
                    toast.success('Commit SHA copied');
                  }}
                >
                  <IconGitCommit size={13} stroke={1.6} />
                  <Text size="xs" ff="monospace">
                    {shortSha(deployment.sourceCommit)}
                  </Text>
                </UnstyledButton>
              </Tooltip>
            </>
          ) : null}
          {deployment.status === 'deployed' && deployment.hasArtifact ? (
            <>
              {deployment.sourceCommit || deployment.sourceTag ? (
                <MetaDot />
              ) : null}
              <Tooltip label="Download bundle (.js)" withArrow position="top">
                <UnstyledButton
                  component="a"
                  href={`/api/workflows/${workflowId}/download?deployment=${deployment.id}`}
                  download
                  className={classes.metaItem}
                >
                  <IconFileCode size={13} stroke={1.6} />
                  <Text size="xs">Bundle</Text>
                  <IconDownload size={12} stroke={1.6} />
                </UnstyledButton>
              </Tooltip>
            </>
          ) : null}
        </Group>
      ) : null}

      {deployment.message ? (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {deployment.message}
        </Text>
      ) : null}

      {hasLog ? (
        <Box>
          <UnstyledButton
            type="button"
            onClick={handlers.toggle}
            className={classes.logToggle}
          >
            <IconChevronRight
              size={14}
              className={`${classes.chevron} ${open ? classes.chevronOpen : ''}`}
            />
            <Text size="xs" c="dimmed" fw={500}>
              {deployment.status === 'failed' ? 'Error log' : 'Build log'}
            </Text>
          </UnstyledButton>
          <Collapse expanded={open}>
            <Stack gap={6} mt={6}>
              {deployment.error ? (
                <Code
                  block
                  className={`${classes.logCode} ${classes.logError}`}
                >
                  {deployment.error}
                </Code>
              ) : null}
              {deployment.hasBuildLog ? (
                logQuery.isLoading ? (
                  <Group gap={6} className={classes.metaItem}>
                    <Loader size="xs" />
                    <Text size="xs">Loading build log…</Text>
                  </Group>
                ) : logQuery.isError ? (
                  <Text size="xs" c="red">
                    Failed to load build log.
                  </Text>
                ) : logQuery.data ? (
                  <Code block className={classes.logCode}>
                    {logQuery.data}
                  </Code>
                ) : (
                  <Text size="xs" c="dimmed">
                    Build log is empty.
                  </Text>
                )
              ) : null}
            </Stack>
          </Collapse>
        </Box>
      ) : null}
    </Stack>
  );

  const meta = STATUS_META[deployment.status];

  return (
    <Timeline.Item
      lineVariant={deployment.status === 'failed' ? 'dashed' : 'solid'}
      bullet={
        <ThemeIcon
          size={20}
          radius="xl"
          color={meta.color}
          variant={deployment.isCurrent ? 'filled' : 'light'}
        >
          {meta.icon}
        </ThemeIcon>
      }
    >
      {deployment.isCurrent ? (
        <Box className={classes.currentItem}>{body}</Box>
      ) : (
        body
      )}
    </Timeline.Item>
  );
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

  const deployments = query.data ?? [];

  return (
    <Box component="section">
      <Group gap={8} mb="md" align="baseline">
        <Text fw={600} fz="lg">
          Deployment history
        </Text>
        {deployments.length > 0 ? (
          <Text size="sm" c="dimmed">
            {deployments.length}
          </Text>
        ) : null}
      </Group>

      {query.isLoading ? (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      ) : deployments.length === 0 ? (
        <Text size="sm" c="dimmed">
          No deployments yet. Deploy this workflow to create the first version.
        </Text>
      ) : (
        <Timeline
          bulletSize={20}
          lineWidth={2}
          active={-1}
          color="gray"
          styles={{ itemBody: { paddingBottom: 'var(--mantine-spacing-md)' } }}
        >
          {deployments.map((deployment) => (
            <DeploymentItem
              key={deployment.id}
              workflowId={workflowId}
              deployment={deployment}
              onRollback={(deploymentId) => rollback.mutate(deploymentId)}
              rolling={
                rollback.isPending && rollback.variables === deployment.id
              }
            />
          ))}
        </Timeline>
      )}
    </Box>
  );
}
