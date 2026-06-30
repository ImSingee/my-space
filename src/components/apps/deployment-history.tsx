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
  IconFileZip,
  IconGitCommit,
  IconLoader,
  IconRestore,
  IconTag,
  IconX,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  appOpsQueryOptions,
  deploymentBuildLogQueryOptions,
  deploymentsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import type { DeploymentSummary } from '~server/apps/manage';
import { rollbackAppFn } from '~server/apps';
import classes from './deployment-history.module.css';

dayjs.extend(relativeTime);

const STATUS_META: Record<
  DeploymentSummary['status'],
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
  appId,
  deployment,
  onRollback,
  rolling,
}: {
  appId: string;
  deployment: DeploymentSummary;
  onRollback: (deploymentId: string) => void;
  rolling: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  const hasLog = Boolean(deployment.error) || deployment.hasBuildLog;
  // Fetch the (potentially large) build log only once the row is expanded.
  const logQuery = useQuery({
    ...deploymentBuildLogQueryOptions(appId, deployment.id),
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
          {/* "Deployed" is the expected default; only surface the label for the
              states that actually need calling out (building / failed). */}
          {deployment.status !== 'deployed' ? (
            <Text size="xs" c="dimmed">
              {STATUS_META[deployment.status].label}
            </Text>
          ) : null}
          <MetaDot />
          <Text size="xs" c="dimmed" truncate>
            {dayjs(deployment.createdAt).fromNow()}
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
          {deployment.status === 'deployed' ? (
            <>
              {deployment.sourceCommit || deployment.sourceTag ? (
                <MetaDot />
              ) : null}
              {deployment.hasArtifact ? (
                <Tooltip
                  label="Download artifact (.tar.gz)"
                  withArrow
                  position="top"
                >
                  <UnstyledButton
                    component="a"
                    href={`/api/apps/${appId}/download?mode=artifact&deployment=${deployment.id}`}
                    download
                    className={classes.metaItem}
                  >
                    <IconFileZip size={13} stroke={1.6} />
                    <Text size="xs">Artifact</Text>
                    <IconDownload size={12} stroke={1.6} />
                  </UnstyledButton>
                </Tooltip>
              ) : (
                <Box component="span" className={classes.metaItem}>
                  <IconFileZip size={13} stroke={1.6} />
                  <Text size="xs">Artifact pruned</Text>
                </Box>
              )}
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
    onError: (error) => toast.error((error as Error).message),
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
          No deployments yet. Deploy this app to create the first version.
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
              appId={appId}
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
