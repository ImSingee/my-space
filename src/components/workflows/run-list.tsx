import { Box, Center, Group, Loader, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatDuration, formatRelative } from '~lib/format';
import { workflowRunsQueryOptions } from '~queries/workflows';
import { RunStatusBadge } from './run-status';

export function WorkflowRunList({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const query = useQuery({
    ...workflowRunsQueryOptions(workflowId),
    refetchInterval: (q) => {
      const runs = q.state.data ?? [];
      // Fast poll while a run is in flight so progress updates near-live.
      if (runs.some((r) => r.status === 'queued' || r.status === 'running')) {
        return 1500;
      }
      // Otherwise keep a slow idle poll so background-triggered runs (cron /
      // webhook) appear without a manual refresh. React Query pauses this while
      // the tab is hidden (refetchIntervalInBackground defaults false).
      return 15_000;
    },
  });

  const runs = query.data ?? [];

  return (
    <Box component="section">
      <Group gap={8} mb="md" align="baseline">
        <Text fw={600} fz="lg">
          Executions
        </Text>
        {runs.length > 0 ? (
          <Text size="sm" c="dimmed">
            {runs.length}
          </Text>
        ) : null}
      </Group>

      {query.isLoading ? (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      ) : runs.length === 0 ? (
        <Text size="sm" c="dimmed">
          No executions yet. Trigger this workflow to see its history here.
        </Text>
      ) : (
        <Table highlightOnHover verticalSpacing="sm" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Status</Table.Th>
              <Table.Th w={110}>Trigger</Table.Th>
              <Table.Th w={80}>Steps</Table.Th>
              <Table.Th w={110}>Duration</Table.Th>
              <Table.Th w={150}>Started</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((run) => (
              <Table.Tr
                key={run.id}
                style={{ cursor: 'pointer' }}
                onClick={() =>
                  navigate({
                    to: '/workflows/$workflowId/executions/$runId',
                    params: { workflowId, runId: run.id },
                  })
                }
              >
                <Table.Td>
                  {/* Real link (not just the row onClick) so open-in-new-tab
                      and keyboard navigation work. stopPropagation keeps a
                      modified click from ALSO firing the row's onClick and
                      navigating the current tab. */}
                  <Link
                    to="/workflows/$workflowId/executions/$runId"
                    params={{ workflowId, runId: run.id }}
                    style={{ textDecoration: 'none' }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RunStatusBadge status={run.status} />
                  </Link>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed" tt="capitalize">
                    {run.trigger}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {run.stepCount}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {formatDuration(run.durationMs)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {formatRelative(run.startedAt ?? run.createdAt)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Box>
  );
}
