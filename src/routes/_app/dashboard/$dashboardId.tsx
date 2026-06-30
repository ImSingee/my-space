import {
  ActionIcon,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import {
  IconDots,
  IconFileText,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { Suspense, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import { DashboardEmptyState } from '~components/dashboard/empty-state';
import {
  appsQueryOptions,
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/apps';
import {
  type Dashboard,
  addDashboardWidget,
  deleteDashboard,
  removeDashboardWidget,
  renameDashboard,
  setDashboardDescription,
  updateDashboardLayout,
} from '~server/apps';

const DEFAULT_DASHBOARD_DESCRIPTION =
  'A home for the widgets and apps you care about.';

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
      context.queryClient.ensureQueryData(appsQueryOptions),
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
  // Empty description is a valid state: render no subtitle rather than
  // falling back to a canned default.
  const description = current?.description?.trim() || undefined;

  return (
    <Page
      title={current?.name ?? 'Dashboard'}
      description={description}
      actions={
        <>
          <AddWidgetMenu dashboardId={dashboardId} />
          {current ? <DashboardMenu dashboard={current} /> : null}
        </>
      }
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
  const { data: apps } = useSuspenseQuery(appsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardQueryOptions(dashboardId).queryKey,
    });

  const remove = useMutation({
    mutationFn: (id: string) => removeDashboardWidget({ data: id }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error((error as Error).message),
  });

  // Persist layout saves one at a time, always sending the most recent layout
  // last. Each drag/resize fires onLayoutChange; firing independent requests
  // lets a slow earlier save land after a newer one and overwrite it. We keep
  // only the latest pending layout and drain it after the in-flight save.
  const pendingLayout = useRef<
    { id: string; x: number; y: number; w: number; h: number }[] | null
  >(null);
  const savingLayout = useRef(false);
  const flushLayout = useCallback(async () => {
    if (savingLayout.current) return;
    savingLayout.current = true;
    try {
      while (pendingLayout.current) {
        const next = pendingLayout.current;
        pendingLayout.current = null;
        try {
          await updateDashboardLayout({ data: next });
        } catch (error) {
          toast.error((error as Error).message);
          // Don't retry the failed layout (avoids a spin on a persistent
          // failure), but leave pendingLayout untouched: if the user moved again
          // during this save, that newer layout is queued there and must still
          // be persisted on the next loop turn.
        }
      }
    } finally {
      savingLayout.current = false;
    }
  }, []);

  if (widgets.length === 0) {
    return <DashboardEmptyState hasApps={apps.length > 0} />;
  }

  return (
    <DashboardGrid
      items={widgets}
      onRemove={(id) => remove.mutate(id)}
      onLayoutChange={(layout) => {
        const next = layout.map((l) => ({
          id: l.i,
          x: l.x,
          y: l.y,
          w: l.w,
          h: l.h,
        }));
        pendingLayout.current = next;
        // Reflect the new geometry in the cache immediately. The layout save
        // intentionally doesn't refetch, so without this a size-aware widget
        // (one reading context.size.w/h) would keep its stale grid units until
        // the next reload — the resized iframe never gets the `units` message.
        // It also matches what RGL already rendered, so it can't fight a drag.
        const byId = new Map(next.map((n) => [n.id, n]));
        queryClient.setQueryData(
          dashboardQueryOptions(dashboardId).queryKey,
          (old) =>
            old?.map((item) => {
              const g = byId.get(item.id);
              return g ? { ...item, x: g.x, y: g.y, w: g.w, h: g.h } : item;
            }),
        );
        void flushLayout();
      }}
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

function DashboardMenu({ dashboard }: { dashboard: Dashboard }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: dashboards } = useSuspenseQuery(dashboardsQueryOptions);
  const [renameOpen, setRenameOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [nameValue, setNameValue] = useState(dashboard.name);
  const [descValue, setDescValue] = useState(dashboard.description ?? '');

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const rename = useMutation({
    mutationFn: (name: string) =>
      renameDashboard({ data: { id: dashboard.id, name } }),
    onSuccess: async () => {
      await invalidate();
      setRenameOpen(false);
      toast.success('Dashboard renamed');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const saveDescription = useMutation({
    mutationFn: (description: string) =>
      setDashboardDescription({ data: { id: dashboard.id, description } }),
    onSuccess: async () => {
      await invalidate();
      setDescOpen(false);
      toast.success('Description updated');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => deleteDashboard({ data: dashboard.id }),
    onSuccess: async () => {
      const next = dashboards.find((d) => d.id !== dashboard.id);
      if (next) {
        await navigate({
          to: '/dashboard/$dashboardId',
          params: { dashboardId: next.id },
        });
      }
      await invalidate();
      toast.success('Dashboard deleted');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const submitRename = () => {
    if (nameValue.trim()) rename.mutate(nameValue.trim());
  };

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: 'Delete dashboard',
      centered: true,
      children: (
        <Text size="sm">
          Delete “{dashboard.name}”? Its widget layout will be removed.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
    <>
      <Menu position="bottom-end" withArrow shadow="md" width={200}>
        <Menu.Target>
          <ActionIcon
            variant="default"
            size="input-sm"
            aria-label="Dashboard options"
          >
            <IconDots size={18} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={15} stroke={1.7} />}
            onClick={() => {
              setNameValue(dashboard.name);
              setRenameOpen(true);
            }}
          >
            Rename
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileText size={15} stroke={1.7} />}
            onClick={() => {
              setDescValue(dashboard.description ?? '');
              setDescOpen(true);
            }}
          >
            Edit description
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={15} stroke={1.7} />}
            disabled={dashboards.length <= 1}
            onClick={confirmDelete}
          >
            Delete
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal
        opened={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename dashboard"
        centered
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            label="Name"
            value={nameValue}
            onChange={(e) => setNameValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitRename();
              }
            }}
          />
          <Group justify="flex-end">
            <Button
              type="button"
              loading={rename.isPending}
              disabled={!nameValue.trim()}
              onClick={submitRename}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={descOpen}
        onClose={() => setDescOpen(false)}
        title="Edit description"
        centered
      >
        <Stack gap="sm">
          <Textarea
            data-autofocus
            label="Description"
            placeholder={DEFAULT_DASHBOARD_DESCRIPTION}
            autosize
            minRows={3}
            maxRows={6}
            value={descValue}
            onChange={(e) => setDescValue(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button
              type="button"
              loading={saveDescription.isPending}
              onClick={() => saveDescription.mutate(descValue)}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
