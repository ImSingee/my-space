import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconClock, IconHistory, IconPlayerPlay } from '@tabler/icons-react';
import { toast } from 'sonner';
import { formatDuration, formatExact, formatRelative } from '~lib/format';
import { appOpsQueryOptions, cronRunsQueryOptions } from '~queries/apps';
import type { AppOps } from '~server/apps';
import { runCronJobFn } from '~server/apps';
import { SectionHeader } from './section-header';

// Recent cron-trigger history (scheduled fires + manual "Run now"), newest
// first. Distinct from the backend log stream: structured per-run rows with
// trigger, status, and duration. Mirrors the workflow Executions table.
function CronHistory({ appId }: { appId: string }) {
  const query = useQuery(cronRunsQueryOptions(appId));
  const runs = query.data ?? [];

  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap">
        <IconHistory size={16} stroke={1.8} />
        <Text fw={600} size="sm">
          Trigger history
        </Text>
        {runs.length > 0 ? (
          <Text size="xs" c="dimmed">
            {runs.length}
          </Text>
        ) : null}
      </Group>
      {query.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : runs.length === 0 ? (
        <Text size="xs" c="dimmed">
          No runs yet. Scheduled fires and manual runs will appear here.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Job</Table.Th>
              <Table.Th w={110}>Trigger</Table.Th>
              <Table.Th w={90}>Status</Table.Th>
              <Table.Th w={80}>Duration</Table.Th>
              <Table.Th w={120}>When</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((run) => (
              <Table.Tr key={run.id}>
                <Table.Td>
                  <Text size="sm" fw={500} truncate>
                    {run.jobName}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="default">
                    {run.trigger}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="xs"
                    variant="light"
                    color={run.ok ? 'teal' : 'red'}
                  >
                    {run.ok ? 'ok' : 'fail'}
                    {run.status != null ? ` ${run.status}` : ''}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {formatDuration(run.durationMs)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip
                    label={formatExact(run.createdAt)}
                    withArrow
                    position="left"
                  >
                    <Text size="xs" c="dimmed">
                      {formatRelative(run.createdAt)}
                    </Text>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

/** Declared cron jobs with a manual "Run now" trigger, plus run history. */
export function CronSection({
  appId,
  cron,
}: {
  appId: string;
  cron: AppOps['cron'];
}) {
  const qc = useQueryClient();

  const runCron = useMutation({
    mutationFn: (name: string) => runCronJobFn({ data: { id: appId, name } }),
    onSuccess: (res, name) => {
      if (res.status >= 200 && res.status < 300) {
        toast.success(`Ran "${name}" (${res.status})`);
      } else {
        toast.error(`"${name}" returned ${res.status}`);
      }
    },
    // A manual run records a history row on BOTH paths: success returns an HTTP
    // status, but a thrown failure (backend unreachable) also writes a `manual`
    // row and rethrows into onError. Invalidate in onSettled so the new row
    // shows immediately whether the call succeeded or threw.
    onSettled: () => {
      void qc.invalidateQueries(appOpsQueryOptions(appId));
      void qc.invalidateQueries(cronRunsQueryOptions(appId));
    },
  });

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconClock size={16} stroke={1.8} />}
        title="Scheduled jobs"
      />
      {cron.jobs.length === 0 ? (
        <Text size="xs" c="dimmed">
          No cron jobs declared in the manifest.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {cron.jobs.map((job) => (
              <Table.Tr key={job.name}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {job.name}
                  </Text>
                </Table.Td>
                <Table.Td w={120}>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {job.schedule}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap" align="center">
                    <Badge
                      size="xs"
                      variant="light"
                      color={job.method ? 'blue' : 'gray'}
                    >
                      {job.method ? 'rpc' : 'path'}
                    </Badge>
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {job.method ?? job.path}
                      {job.nextRun
                        ? ` · next ${formatRelative(job.nextRun)}`
                        : ''}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td w={110}>
                  <Button
                    size="compact-sm"
                    variant="light"
                    leftSection={<IconPlayerPlay size={14} />}
                    loading={
                      runCron.isPending && runCron.variables === job.name
                    }
                    onClick={() => runCron.mutate(job.name)}
                  >
                    Run now
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <CronHistory appId={appId} />
    </Stack>
  );
}
