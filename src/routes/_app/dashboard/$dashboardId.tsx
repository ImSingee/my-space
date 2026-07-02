import {
  ActionIcon,
  Button,
  Center,
  Loader,
  Menu,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import {
  IconCheck,
  IconChevronDown,
  IconDots,
  IconFileText,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import { DashboardEmptyState } from '~components/dashboard/empty-state';
import {
  REFRESH_PRESETS,
  formatInterval,
} from '~components/dashboard/refresh-presets';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { appsQueryOptions } from '~queries/apps';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import {
  type Dashboard,
  addDashboardWidget,
  deleteDashboard,
  removeDashboardWidget,
  renameDashboard,
  setDashboardAutoRefresh,
  setDashboardDescription,
  updateDashboardLayout,
} from '~server/dashboards';

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

  // Bumping this fans a refresh out to every widget on the dashboard (each
  // widget refetches in place via its registered context.onRefresh handler).
  const [refreshSignal, setRefreshSignal] = useState(0);

  // Grafana-style auto-refresh: when an interval is configured, tick the same
  // refresh signal the manual button uses so every widget refetches in place.
  // dashboardId is a dependency so switching dashboards restarts the timer with
  // a fresh phase (otherwise a same-interval switch would inherit the old one).
  const autoRefreshSeconds = current?.autoRefreshSeconds ?? 0;
  useEffect(() => {
    if (autoRefreshSeconds <= 0) return;
    const id = setInterval(
      () => setRefreshSignal((s) => s + 1),
      autoRefreshSeconds * 1000,
    );
    return () => clearInterval(id);
  }, [autoRefreshSeconds, dashboardId]);

  return (
    <Page
      title={current?.name ?? 'Dashboard'}
      description={description}
      actions={
        <>
          <Tooltip label="Refresh all widgets" withArrow>
            <ActionIcon
              variant="default"
              size="input-sm"
              aria-label="Refresh all widgets"
              onClick={() => setRefreshSignal((s) => s + 1)}
            >
              <IconRefresh size={18} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
          {current ? <AutoRefreshMenu dashboard={current} /> : null}
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
        <DashboardWidgets
          key={dashboardId}
          dashboardId={dashboardId}
          refreshSignal={refreshSignal}
        />
      </Suspense>
    </Page>
  );
}

function DashboardWidgets({
  dashboardId,
  refreshSignal,
}: {
  dashboardId: string;
  refreshSignal: number;
}) {
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
      refreshSignal={refreshSignal}
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

function AutoRefreshMenu({ dashboard }: { dashboard: Dashboard }) {
  const queryClient = useQueryClient();
  const setAuto = useMutation({
    mutationFn: (seconds: number) =>
      setDashboardAutoRefresh({ data: { id: dashboard.id, seconds } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      }),
  });
  const active = dashboard.autoRefreshSeconds > 0;

  return (
    <Menu position="bottom-end" withArrow shadow="md" width={160}>
      <Menu.Target>
        <Tooltip label="Auto refresh interval" withArrow>
          <Button
            type="button"
            variant={active ? 'light' : 'default'}
            rightSection={<IconChevronDown size={14} stroke={1.8} />}
          >
            {active ? formatInterval(dashboard.autoRefreshSeconds) : 'Off'}
          </Button>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Auto refresh</Menu.Label>
        {REFRESH_PRESETS.map((preset) => (
          <Menu.Item
            key={preset.seconds}
            rightSection={
              preset.seconds === dashboard.autoRefreshSeconds ? (
                <IconCheck size={14} stroke={2} />
              ) : null
            }
            onClick={() => setAuto.mutate(preset.seconds)}
          >
            {preset.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
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

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const rename = useMutation({
    mutationFn: (name: string) =>
      renameDashboard({ data: { id: dashboard.id, name } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Dashboard renamed');
    },
  });

  const saveDescription = useMutation({
    mutationFn: (description: string) =>
      setDashboardDescription({ data: { id: dashboard.id, description } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Description updated');
    },
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
  });

  const openRename = () =>
    openTextPromptModal({
      title: 'Rename dashboard',
      label: 'Name',
      initialValue: dashboard.name,
      onSubmit: (name) => rename.mutateAsync(name),
    });

  const openDescription = () =>
    openTextPromptModal({
      title: 'Edit description',
      label: 'Description',
      placeholder: DEFAULT_DASHBOARD_DESCRIPTION,
      initialValue: dashboard.description ?? '',
      multiline: true,
      allowEmpty: true,
      onSubmit: (description) => saveDescription.mutateAsync(description),
    });

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
            onClick={openRename}
          >
            Rename
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFileText size={15} stroke={1.7} />}
            onClick={openDescription}
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
    </>
  );
}
