import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import { DashboardGrid } from './dashboard-grid';

/** Reuse the real widget runtime without exposing layout editing or navigation. */
export function MobileDashboardCanvas({
  dashboardId,
}: {
  dashboardId: string;
}) {
  const data = useQuery(dashboardQueryOptions(dashboardId));
  const dashboards = useQuery(dashboardsQueryOptions);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const interval =
    dashboards.data?.find((d) => d.id === dashboardId)?.autoRefreshSeconds ?? 0;

  useEffect(() => {
    if (interval <= 0) return;
    const timer = window.setInterval(
      () => setRefreshSignal((value) => value + 1),
      interval * 1000,
    );
    return () => window.clearInterval(timer);
  }, [interval]);

  const refresh = () => {
    void data.refetch();
    void dashboards.refetch();
    setRefreshSignal((value) => value + 1);
  };

  if (data.isPending || dashboards.isPending)
    return (
      <Center mih="60dvh" component="output" aria-label="Loading dashboard">
        <Loader size="sm" />
      </Center>
    );
  if (data.isError || dashboards.isError)
    return (
      <Stack p="lg" role="alert">
        <Text>Couldn’t load this dashboard.</Text>
        <Button type="button" onClick={refresh}>
          Try again
        </Button>
      </Stack>
    );

  return (
    <Box p="sm" component="main" aria-label="Dashboard canvas">
      <Group justify="flex-end" mb="sm">
        <ActionIcon
          type="button"
          variant="subtle"
          aria-label="Refresh dashboard"
          onClick={refresh}
        >
          <IconRefresh size={18} />
        </ActionIcon>
      </Group>
      {data.data.widgets.length === 0 ? (
        <Stack align="center" justify="center" p="xl" mih="60dvh" gap="sm">
          <Text size="xl" fw={600}>
            No widgets yet
          </Text>
          <Text c="dimmed" ta="center">
            Add widgets to this dashboard from Hatch on the web.
          </Text>
        </Stack>
      ) : (
        <DashboardGrid
          items={data.data.widgets}
          layouts={data.data.layouts}
          editing={false}
          onRemove={() => {}}
          onLayoutCommit={() => {}}
          refreshSignal={refreshSignal}
        />
      )}
    </Box>
  );
}
