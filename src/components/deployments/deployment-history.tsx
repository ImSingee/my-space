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
import type { UseQueryResult } from '@tanstack/react-query';
import {
  IconCheck,
  IconChevronRight,
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
import classes from './deployment-history.module.css';

/**
 * Structural shape shared by app `DeploymentSummary` and workflow
 * `WorkflowDeploymentSummary` — the timeline renders either.
 */
export type DeploymentLike = {
  id: string;
  version: number;
  status: 'building' | 'deployed' | 'failed';
  message: string | null;
  error: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
  sourceCommit: string | null;
  sourceTag: string | null;
  hasArtifact: boolean;
  hasBuildLog: boolean;
};

const STATUS_META: Record<
  DeploymentLike['status'],
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

/** Inline meta-row chip style for wrapper-provided artifact links. */
export const metaItemClass = classes.metaItem;

export function MetaDot() {
  return (
    <Text span size="xs" className={classes.metaDot}>
      ·
    </Text>
  );
}

/**
 * Loading / error / content states for a lazily-fetched build log. Wrappers own
 * the query (each side has its own query options); this renders the result.
 */
export function BuildLogContent({
  query,
}: {
  query: UseQueryResult<string | null>;
}) {
  if (query.isLoading) {
    return (
      <Group gap={6} className={classes.metaItem}>
        <Loader size="xs" />
        <Text size="xs">Loading build log…</Text>
      </Group>
    );
  }
  if (query.isError) {
    return (
      <Text size="xs" c="red">
        Failed to load build log.
      </Text>
    );
  }
  if (query.data) {
    return (
      <Code block className={classes.logCode}>
        {query.data}
      </Code>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      Build log is empty.
    </Text>
  );
}

function DeploymentItem({
  deployment,
  onRollback,
  rolling,
  renderArtifact,
  renderBuildLog,
}: {
  deployment: DeploymentLike;
  onRollback: (deploymentId: string) => void;
  rolling: boolean;
  /** Download link(s) shown for a deployed version, or null to omit. */
  renderArtifact: (deployment: DeploymentLike) => ReactNode;
  /** Lazily-fetched build log body (mounted only when `hasBuildLog`). */
  renderBuildLog: (deploymentId: string, open: boolean) => ReactNode;
}) {
  const [open, handlers] = useDisclosure(false);
  const hasLog = Boolean(deployment.error) || deployment.hasBuildLog;
  const artifactNode =
    deployment.status === 'deployed' ? renderArtifact(deployment) : null;

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
      artifactNode != null ? (
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
          {artifactNode != null ? (
            <>
              {deployment.sourceCommit || deployment.sourceTag ? (
                <MetaDot />
              ) : null}
              {artifactNode}
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
              {deployment.hasBuildLog
                ? renderBuildLog(deployment.id, open)
                : null}
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

/**
 * Shared deployment-history timeline for apps and workflows. Wrappers own the
 * data fetching and rollback mutation (query keys and invalidations differ);
 * this owns all presentation.
 */
export function DeploymentHistoryView({
  deployments,
  isLoading,
  emptyNoun,
  onRollback,
  rollingId,
  renderArtifact,
  renderBuildLog,
}: {
  deployments: DeploymentLike[];
  isLoading: boolean;
  /** "app" or "workflow" — used in the empty-state copy. */
  emptyNoun: string;
  onRollback: (deploymentId: string) => void;
  /** Deployment id currently being restored, if any. */
  rollingId: string | null;
  renderArtifact: (deployment: DeploymentLike) => ReactNode;
  renderBuildLog: (deploymentId: string, open: boolean) => ReactNode;
}) {
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

      {isLoading ? (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      ) : deployments.length === 0 ? (
        <Text size="sm" c="dimmed">
          No deployments yet. Deploy this {emptyNoun} to create the first
          version.
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
              deployment={deployment}
              onRollback={onRollback}
              rolling={rollingId === deployment.id}
              renderArtifact={renderArtifact}
              renderBuildLog={renderBuildLog}
            />
          ))}
        </Timeline>
      )}
    </Box>
  );
}
