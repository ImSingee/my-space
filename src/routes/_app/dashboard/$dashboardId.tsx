import {
  Button,
  Card,
  Center,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { IconLayoutGrid, IconPlus } from '@tabler/icons-react';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/apps';
import {
  addDashboardWidget,
  removeDashboardWidget,
  updateDashboardLayout,
} from '~server/apps';
import classes from './dashboard.module.css';

export const Route = createFileRoute('/_app/dashboard/$dashboardId')({
  loader: async ({ context, params }) => {
    const dashboards = await context.queryClient.ensureQueryData(
      dashboardsQueryOptions,
    );
    if (!dashboards.some((d) => d.id === params.dashboardId)) {
      const first = dashboards[0]?.id;
      if (first) {
        throw redirect({
          to: '/dashboard/$dashboardId',
          params: { dashboardId: first },
        });
      }
    }
    await Promise.all([
      context.queryClient.ensureQueryData(availableWidgetsQueryOptions),
      context.queryClient.ensureQueryData(
        dashboardQueryOptions(params.dashboardId),
      ),
    ]);
  },
  component: DashboardPage,
});

function DashboardPage() {
  const { dashboardId } = Route.useParams();
  const { data: dashboards } = useSuspenseQuery(dashboardsQueryOptions);
  const current = dashboards.find((d) => d.id === dashboardId);

  return (
    <Page
      title={current?.name ?? 'Dashboard'}
      description="A home for the widgets and apps you care about."
      actions={<AddWidgetMenu dashboardId={dashboardId} />}
    >
      <Suspense
        fallback={
          <Center py={64}>
            <Loader />
          </Center>
        }
      >
        <DashboardWidgets key={dashboardId} dashboardId={dashboardId} />
      </Suspense>
    </Page>
  );
}

function DashboardWidgets({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient();
  const { data: widgets } = useSuspenseQuery(
    dashboardQueryOptions(dashboardId),
  );

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardQueryOptions(dashboardId).queryKey,
    });

  const remove = useMutation({
    mutationFn: (id: string) => removeDashboardWidget({ data: id }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error((error as Error).message),
  });

  const saveLayout = useMutation({
    mutationFn: (
      items: { id: string; x: number; y: number; w: number; h: number }[],
    ) => updateDashboardLayout({ data: items }),
    onError: (error) => toast.error((error as Error).message),
  });

  if (widgets.length === 0) {
    return (
      <Card withBorder padding={0} className={classes.canvas}>
        <Stack align="center" gap="xs" py={64} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="gray">
            <IconLayoutGrid size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={600} mt="xs">
            No widgets here yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            Widgets exposed by your apps appear here. Build an app with the
            Agent, deploy it, then add its widgets with the button above.
          </Text>
        </Stack>
      </Card>
    );
  }

  return (
    <DashboardGrid
      items={widgets}
      onRemove={(id) => remove.mutate(id)}
      onLayoutChange={(layout) =>
        saveLayout.mutate(
          layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
        )
      }
    />
  );
}

function AddWidgetMenu({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient();
  const { data: available } = useSuspenseQuery(availableWidgetsQueryOptions);

  const add = useMutation({
    mutationFn: (input: { appId: string; widgetId: string }) =>
      addDashboardWidget({ data: { dashboardId, ...input } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: dashboardQueryOptions(dashboardId).queryKey,
      });
      toast.success('Widget added to dashboard');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  return (
    <Menu position="bottom-end" withArrow shadow="md" width={260}>
      <Menu.Target>
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          variant="default"
          disabled={available.length === 0}
        >
          Add widget
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {available.length === 0 ? (
          <Menu.Item disabled>No deployed widgets yet</Menu.Item>
        ) : (
          available.map((widget) => (
            <Menu.Item
              key={`${widget.appId}:${widget.widgetId}`}
              onClick={() =>
                add.mutate({
                  appId: widget.appId,
                  widgetId: widget.widgetId,
                })
              }
            >
              <Text size="sm">{widget.name}</Text>
              <Text size="xs" c="dimmed">
                {widget.appName}
              </Text>
            </Menu.Item>
          ))
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
