import {
  Box,
  Button,
  Group,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { IconTimeline } from '@tabler/icons-react';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { RunStatusBadge } from '~components/workflows/run-status';
import { formatDuration, formatRelative } from '~lib/format';
import { allWorkflowRunsQueryOptions } from '~queries/workflows';
import { listAllWorkflowRuns } from '~server/workflows';

export const Route = createFileRoute('/_app/executions')({
  loader: () => listAllWorkflowRuns(),
  component: ExecutionsPage,
});

function ExecutionsPage() {
  const initial = Route.useLoaderData();
  const navigate = useNavigate();
  const query = useQuery({
    ...allWorkflowRunsQueryOptions,
    initialData: initial,
    // Live-refresh while any execution is still in flight.
    refetchInterval: (q) => {
      const runs = q.state.data ?? [];
      return runs.some((r) => r.status === 'queued' || r.status === 'running')
        ? 1500
        : false;
    },
  });

  const runs = query.data ?? [];

  return (
    <Page
      title="Executions"
      description="Run history across every workflow."
      actions={
        <Button component={Link} to="/workflows" variant="default">
          Workflows
        </Button>
      }
    >
      {runs.length === 0 ? (
        <Stack align="center" gap="xs" py={80} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="ember">
            <IconTimeline size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={600} mt="xs">
            No executions yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            Trigger a workflow manually, on a schedule, or via webhook and every
            run will show up here.
          </Text>
        </Stack>
      ) : (
        <Box component="section">
          <Table highlightOnHover verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Workflow</Table.Th>
                <Table.Th w={150}>Status</Table.Th>
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
                      params: { workflowId: run.workflowId, runId: run.id },
                    })
                  }
                >
                  <Table.Td>
                    {/* Real link (not just the row onClick) so open-in-new-tab
                        and keyboard navigation work. stopPropagation keeps a
                        modified click from ALSO firing the row's onClick and
                        navigating the current tab. */}
                    <Group
                      gap="sm"
                      wrap="nowrap"
                      style={{
                        minWidth: 0,
                        color: 'inherit',
                        textDecoration: 'none',
                      }}
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/workflows/$workflowId/executions/$runId"
                          params={{
                            workflowId: run.workflowId,
                            runId: run.id,
                          }}
                          onClick={(event) => event.stopPropagation()}
                        />
                      )}
                    >
                      <AppGlyph
                        name={run.workflowName}
                        seed={run.workflowId}
                        size="sm"
                      />
                      <Text size="sm" fw={500} truncate>
                        {run.workflowName}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <RunStatusBadge status={run.status} />
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
        </Box>
      )}
    </Page>
  );
}
