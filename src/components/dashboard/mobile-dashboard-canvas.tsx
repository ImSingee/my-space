import { Box, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { dashboardQueryOptions } from '~queries/dashboards';
import { DashboardGrid } from './dashboard-grid';

/** Reuse the real widget runtime without exposing layout editing or navigation. */
export function MobileDashboardCanvas({
  dashboardId,
}: {
  dashboardId: string;
}) {
  const data = useQuery(dashboardQueryOptions(dashboardId));
  const [refreshSignal, setRefreshSignal] = useState(0);
  const refetch = data.refetch;
  const refresh = useCallback(() => {
    void refetch();
    setRefreshSignal((value) => value + 1);
  }, [refetch]);

  // The native host owns the control and timer. Only refresh this canvas;
  // this command carries no credentials, URLs or executable payload.
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (
        detail &&
        typeof detail === 'object' &&
        'dashboardId' in detail &&
        detail.dashboardId === dashboardId
      )
        refresh();
    };
    window.addEventListener('hatch:dashboard-refresh', receive);
    return () => window.removeEventListener('hatch:dashboard-refresh', receive);
  }, [dashboardId, refresh]);

  if (data.isPending)
    return (
      <Center mih="60dvh" component="output" aria-label="Loading dashboard">
        <Loader size="sm" />
      </Center>
    );
  if (data.isError)
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
          nativeHost
        />
      )}
    </Box>
  );
}
