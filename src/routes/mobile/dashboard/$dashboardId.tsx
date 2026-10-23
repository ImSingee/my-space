import { Box, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import {
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import { hasActiveSession } from '~server/auth';

/** Widget canvas only. The native client owns navigation and dashboard selection. */
export const Route = createFileRoute('/mobile/dashboard/$dashboardId')({
  beforeLoad: async () => {
    if (!(await hasActiveSession())) throw redirect({ to: '/login' });
  },
  component: MobileDashboard,
});

function MobileDashboard() {
  const { dashboardId } = Route.useParams();
  const data = useQuery(dashboardQueryOptions(dashboardId));
  const dashboards = useQuery(dashboardsQueryOptions);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const interval =
    dashboards.data?.find((d) => d.id === dashboardId)?.autoRefreshSeconds ?? 0;
  useEffect(() => {
    if (!interval) return;
    const timer = setInterval(
      () => setRefreshSignal((v) => v + 1),
      interval * 1000,
    );
    return () => clearInterval(timer);
  }, [interval]);
  if (data.isPending)
    return (
      <Center h="60dvh">
        <Loader size="sm" />
      </Center>
    );
  if (data.error)
    return (
      <Stack p="lg">
        <Text>Couldn’t load this dashboard.</Text>
        <Button onClick={() => void data.refetch()}>Try again</Button>
      </Stack>
    );
  if (!data.data.widgets.length)
    return (
      <Stack align="center" justify="center" p="xl" mih="60dvh" gap="sm">
        <Text size="xl" fw={600}>
          Make room for what matters
        </Text>
        <Text c="dimmed" ta="center">
          Add widgets to this dashboard from Hatch on the web. They’ll be here
          whenever you need them.
        </Text>
      </Stack>
    );
  return (
    <Box p="sm">
      <DashboardGrid
        items={data.data.widgets}
        layouts={data.data.layouts}
        editing={false}
        onRemove={() => {}}
        onLayoutCommit={() => {}}
        refreshSignal={refreshSignal}
      />
    </Box>
  );
}
