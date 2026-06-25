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
import { createFileRoute } from '@tanstack/react-router';
import { IconLayoutGrid, IconPlus } from '@tabler/icons-react';
import { Suspense } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
} from '~queries/subapps';
import {
  addDashboardWidget,
  removeDashboardWidget,
  updateDashboardLayout,
} from '~server/subapps';
import classes from './dashboard.module.css';

export const Route = createFileRoute('/_app/dashboard')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(dashboardQueryOptions),
      context.queryClient.ensureQueryData(availableWidgetsQueryOptions),
    ]);
  },
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <Page
      title="Dashboard"
      description="A home for the widgets and apps you care about."
      actions={
        <Suspense fallback={null}>
          <AddWidgetMenu />
        </Suspense>
      }
    >
      <Suspense
        fallback={
          <Center py={64}>
            <Loader />
          </Center>
        }
      >
        <DashboardWidgets />
      </Suspense>
    </Page>
  );
}

function DashboardWidgets() {
  const queryClient = useQueryClient();
  const { data: widgets } = useSuspenseQuery(dashboardQueryOptions);

  const remove = useMutation({
    mutationFn: (id: string) => removeDashboardWidget({ data: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dashboard', 'widgets'],
      });
    },
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
            No widgets pinned yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            Widgets exposed by your subapps appear here. Build a subapp with the
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

function AddWidgetMenu() {
  const queryClient = useQueryClient();
  const { data: available } = useSuspenseQuery(availableWidgetsQueryOptions);

  const add = useMutation({
    mutationFn: (input: { subappId: string; widgetId: string }) =>
      addDashboardWidget({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dashboard', 'widgets'],
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
              key={`${widget.subappId}:${widget.widgetId}`}
              onClick={() =>
                add.mutate({
                  subappId: widget.subappId,
                  widgetId: widget.widgetId,
                })
              }
            >
              <Text size="sm">{widget.name}</Text>
              <Text size="xs" c="dimmed">
                {widget.subappName}
              </Text>
            </Menu.Item>
          ))
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
