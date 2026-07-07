import {
  Alert,
  Badge,
  Button,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconPlugOff, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { formatDuration, formatExact, formatRelative } from '~lib/format';
import type {
  ActiveAgentRunInfo,
  AgentRunLeaseState,
  AgentRunnerState,
  AgentRunnerStatusSnapshot,
  ConnectedRunnerInfo,
} from '~server/agent-runner-status';

const STATE_META: Record<AgentRunnerState, { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'teal' },
  offline: { label: 'Offline', color: 'gray' },
  attention: { label: 'Needs attention', color: 'yellow' },
};

const LEASE_META: Record<
  AgentRunLeaseState,
  { label: string; color: string; hint?: string }
> = {
  live: { label: 'Live', color: 'teal' },
  expired: {
    label: 'Expired',
    color: 'red',
    hint: 'The runner stopped renewing this run — the platform will interrupt it shortly.',
  },
  missing: {
    label: 'Missing',
    color: 'orange',
    hint: 'This active run has no lease recorded, which should never happen.',
  },
};

export type AgentRunnerPanelProps = {
  snapshot: AgentRunnerStatusSnapshot | undefined;
  /** True during the very first load (no data yet). */
  isLoading: boolean;
  error: Error | null;
  onRefresh: () => Promise<unknown> | void;
};

export function AgentRunnerPanel({
  snapshot,
  isLoading,
  error,
  onRefresh,
}: AgentRunnerPanelProps) {
  if (isLoading) return <PanelSkeleton />;
  if (!snapshot) return <LoadFailed error={error} onRefresh={onRefresh} />;
  return (
    <Stack gap="xl">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Badge
            size="lg"
            radius="sm"
            variant="light"
            color={STATE_META[snapshot.state].color}
          >
            {STATE_META[snapshot.state].label}
          </Badge>
          {error ? (
            <Text size="xs" c="red">
              Refresh failed — showing the last known state.
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              Updated {formatRelative(snapshot.generatedAt)}
            </Text>
          )}
        </Group>
        <RefreshButton onRefresh={onRefresh} />
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg">
        <Stat
          label="Connected runners"
          value={snapshot.summary.connectedRunners}
        />
        <Stat label="Active runs" value={snapshot.summary.activeRuns} />
        <Stat label="Blocked runs" value={snapshot.summary.blockedRuns} />
        <Stat label="Stale leases" value={snapshot.summary.staleLeases} />
      </SimpleGrid>

      <Stack gap="xs">
        <Group justify="space-between" align="baseline">
          <Text fw={600}>Runners</Text>
          <Text size="xs" c="dimmed">
            Heartbeat every{' '}
            {formatDuration(snapshot.summary.heartbeatIntervalMs)} · lease TTL{' '}
            {formatDuration(snapshot.summary.leaseTtlMs)}
          </Text>
        </Group>
        {snapshot.runners.length === 0 ? (
          <Alert
            variant="light"
            color="gray"
            icon={<IconPlugOff size={18} stroke={1.6} />}
          >
            No Agent Runner is connected. Start the agent-runner service and it
            will register itself here within a few seconds; agent chats cannot
            run until one is online.
          </Alert>
        ) : (
          <RunnersTable runners={snapshot.runners} />
        )}
      </Stack>

      <Stack gap="xs">
        <Text fw={600}>Active runs</Text>
        {snapshot.activeRuns.length === 0 ? (
          <Text size="sm" c="dimmed">
            No agent runs are running or waiting right now.
          </Text>
        ) : (
          <ActiveRunsTable runs={snapshot.activeRuns} />
        )}
      </Stack>
    </Stack>
  );
}

function RefreshButton({
  onRefresh,
}: {
  onRefresh: AgentRunnerPanelProps['onRefresh'];
}) {
  // Local busy state instead of the query's isFetching: the page also polls
  // every 5 seconds and the button must not blink on every background tick.
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="default"
      size="xs"
      leftSection={<IconRefresh size={14} stroke={1.8} />}
      loading={busy}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onRefresh()).finally(() => setBusy(false));
      }}
    >
      Refresh
    </Button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={26} fw={600} lh={1.2}>
        {value}
      </Text>
    </Stack>
  );
}

/** Relative timestamp with the exact time in a tooltip. */
function TimeCell({ value }: { value: string }) {
  return (
    <Tooltip label={formatExact(value)} withArrow>
      <Text size="sm" c="dimmed" style={{ cursor: 'default' }}>
        {formatRelative(value)}
      </Text>
    </Tooltip>
  );
}

function RunnersTable({ runners }: { runners: ConnectedRunnerInfo[] }) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Runner ID</Table.Th>
            <Table.Th>Protocol</Table.Th>
            <Table.Th>Active runs</Table.Th>
            <Table.Th>Connected since</Table.Th>
            <Table.Th>Last seen</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runners.map((runner) => (
            <Table.Tr key={runner.runnerId}>
              <Table.Td>
                <Text size="sm" ff="monospace">
                  {runner.runnerId}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  v{runner.protocolVersion}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{runner.activeRunCount}</Text>
              </Table.Td>
              <Table.Td>
                <TimeCell value={runner.connectedAt} />
              </Table.Td>
              <Table.Td>
                <TimeCell value={runner.lastSeenAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function ActiveRunsTable({ runs }: { runs: ActiveAgentRunInfo[] }) {
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Chat</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Runner</Table.Th>
            <Table.Th>Lease</Table.Th>
            <Table.Th>Started</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((run) => (
            <Table.Tr key={run.runId}>
              <Table.Td maw={280}>
                <Text
                  size="sm"
                  fw={500}
                  truncate
                  renderRoot={(props) => (
                    <Link
                      to="/agent/$threadId"
                      params={{ threadId: run.sessionId }}
                      {...props}
                    />
                  )}
                >
                  {run.sessionTitle}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge
                  size="sm"
                  variant="light"
                  color={run.status === 'blocked' ? 'yellow' : 'teal'}
                >
                  {run.status}
                </Badge>
              </Table.Td>
              <Table.Td>
                <RunRunnerCell run={run} />
              </Table.Td>
              <Table.Td>
                <LeaseBadge lease={run.lease} />
              </Table.Td>
              <Table.Td>
                <TimeCell value={run.startedAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function RunRunnerCell({ run }: { run: ActiveAgentRunInfo }) {
  if (!run.runnerId) {
    return (
      <Text size="sm" c="dimmed">
        dispatching…
      </Text>
    );
  }
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" ff="monospace">
        {run.runnerId}
      </Text>
      {!run.runnerConnected && (
        <Tooltip
          label="The runner carrying this run is not connected right now."
          withArrow
        >
          <Badge size="xs" variant="light" color="gray">
            offline
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

function LeaseBadge({ lease }: { lease: AgentRunLeaseState }) {
  const meta = LEASE_META[lease];
  const badge = (
    <Badge size="sm" variant="light" color={meta.color}>
      {meta.label}
    </Badge>
  );
  if (!meta.hint) return badge;
  return (
    <Tooltip label={meta.hint} withArrow multiline maw={320}>
      {badge}
    </Tooltip>
  );
}

function LoadFailed({
  error,
  onRefresh,
}: {
  error: Error | null;
  onRefresh: AgentRunnerPanelProps['onRefresh'];
}) {
  return (
    <Alert
      variant="light"
      color="red"
      title="Couldn't load Agent Runner status"
    >
      <Stack gap="sm" align="flex-start">
        <Text size="sm">{error?.message ?? 'Unknown error.'}</Text>
        <RefreshButton onRefresh={onRefresh} />
      </Stack>
    </Alert>
  );
}

function PanelSkeleton() {
  return (
    <Stack gap="xl" data-testid="agent-runner-loading">
      <Group justify="space-between">
        <Skeleton height={26} width={130} radius="sm" />
        <Skeleton height={30} width={92} radius="sm" />
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg">
        {[0, 1, 2, 3].map((i) => (
          <Stack key={i} gap={6}>
            <Skeleton height={12} width={110} radius="sm" />
            <Skeleton height={26} width={40} radius="sm" />
          </Stack>
        ))}
      </SimpleGrid>
      <Stack gap="xs">
        <Skeleton height={18} width={80} radius="sm" />
        <Skeleton height={96} radius="md" />
      </Stack>
      <Stack gap="xs">
        <Skeleton height={18} width={100} radius="sm" />
        <Skeleton height={96} radius="md" />
      </Stack>
    </Stack>
  );
}
