import {
  ActionIcon,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Text,
  Tooltip,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  createFileRoute,
  redirect,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconFileText,
  IconPencil,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { AddWidgetPicker } from '~components/dashboard/add-widget-picker';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import { DashboardLayoutPreview } from '~components/dashboard/dashboard-layout-preview';
import {
  DashboardEmptyState,
  type DashboardEmptyStateKind,
} from '~components/dashboard/empty-state';
import {
  REFRESH_PRESETS,
  formatInterval,
} from '~components/dashboard/refresh-presets';
import {
  type DashboardDraftStatus,
  useDashboardDraft,
} from '~components/dashboard/use-dashboard-draft';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { appsQueryOptions } from '~queries/apps';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import {
  type Dashboard,
  deleteDashboard,
  renameDashboard,
  setDashboardAutoRefresh,
  setDashboardDescription,
} from '~server/dashboards';
import {
  DASHBOARD_PREVIEW_WIDTH,
  dashboardPreviewScale,
  type DashboardBreakpoint,
} from '~/lib/dashboard-layout';
import classes from './dashboard.module.css';

const DEFAULT_DASHBOARD_DESCRIPTION =
  'A home for the widgets and apps you care about.';

export const Route = createFileRoute('/_app/dashboard/$dashboardId')({
  loader: async ({ context, params }) => {
    const dashboards = await context.queryClient.ensureQueryData(
      dashboardsQueryOptions,
    );
    if (!dashboards.some((dashboard) => dashboard.id === params.dashboardId)) {
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

  return (
    <Suspense
      fallback={
        <Center h="100%">
          <Loader />
        </Center>
      }
    >
      <DashboardWorkspace key={dashboardId} dashboardId={dashboardId} />
    </Suspense>
  );
}

function DashboardWorkspace({ dashboardId }: { dashboardId: string }) {
  const { data: dashboards } = useSuspenseQuery(dashboardsQueryOptions);
  const { data: dashboardData } = useSuspenseQuery(
    dashboardQueryOptions(dashboardId),
  );
  const { data: available } = useSuspenseQuery(availableWidgetsQueryOptions);
  const { data: apps } = useSuspenseQuery(appsQueryOptions);
  const current = dashboards.find((dashboard) => dashboard.id === dashboardId);
  const description = current?.description?.trim() || undefined;
  const { ref: measurePreviewViewport, width: availablePreviewWidth } =
    useElementSize<HTMLDivElement>();
  const { ref: measurePreviewCanvas, height: previewCanvasHeight } =
    useElementSize<HTMLDivElement>();
  const [editing, setEditing] = useState(false);
  const [previewBreakpoint, setPreviewBreakpoint] =
    useState<DashboardBreakpoint>('desktop');
  const [addWidgetOpened, setAddWidgetOpened] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const editor = useDashboardDraft({
    dashboardId,
    initialData: dashboardData,
  });
  const previewTargetWidth = DASHBOARD_PREVIEW_WIDTH[previewBreakpoint];
  const previewScale = dashboardPreviewScale(
    previewBreakpoint,
    availablePreviewWidth,
  );
  const scaledPreviewWidth = previewTargetWidth * previewScale;
  const scaledPreviewHeight = previewCanvasHeight * previewScale;

  useBlocker({
    shouldBlockFn: () =>
      editing &&
      (editor.dirty || editor.locked) &&
      !window.confirm('Dashboard changes are not saved yet. Leave this page?'),
    enableBeforeUnload: editing && (editor.dirty || editor.locked),
  });

  const autoRefreshSeconds = current?.autoRefreshSeconds ?? 0;
  useEffect(() => {
    if (editing || autoRefreshSeconds <= 0) return;
    const id = window.setInterval(
      () => setRefreshSignal((signal) => signal + 1),
      autoRefreshSeconds * 1000,
    );
    return () => window.clearInterval(id);
  }, [autoRefreshSeconds, dashboardId, editing]);

  const beginEditing = () => {
    editor.reset(dashboardData);
    setPreviewBreakpoint('desktop');
    setEditing(true);
  };
  const openAddWidget = () => {
    if (!editing) beginEditing();
    setAddWidgetOpened(true);
  };
  const cancelEditing = () => {
    if (!editor.cancel()) return;
    setAddWidgetOpened(false);
    setEditing(false);
  };
  const saveEditing = async () => {
    if (!(await editor.save())) return;
    setAddWidgetOpened(false);
    setEditing(false);
    toast.success('Dashboard changes saved');
  };
  const checkSaveStatus = async () => {
    if (!(await editor.checkStatus())) return;
    setAddWidgetOpened(false);
    setEditing(false);
    toast.success('Dashboard changes saved');
  };

  const emptyState: DashboardEmptyStateKind =
    apps.length === 0
      ? 'no-apps'
      : available.length === 0
        ? 'no-widgets'
        : 'empty-dashboard';

  const activeData = editing ? editor.draft : dashboardData;
  const grid =
    activeData.widgets.length > 0 ? (
      <DashboardGrid
        items={activeData.widgets}
        layouts={activeData.layouts}
        editing={editing}
        previewBreakpoint={editing ? previewBreakpoint : undefined}
        transformScale={editing ? previewScale : 1}
        refreshSignal={refreshSignal}
        removeDisabled={editor.locked}
        interactionDisabled={editor.locked}
        onRemove={editor.removeWidget}
        onLayoutCommit={editor.commitLayout}
      />
    ) : (
      <DashboardEmptyState
        state={emptyState}
        onAddWidget={
          emptyState === 'empty-dashboard' ? openAddWidget : undefined
        }
      />
    );

  return (
    <Page
      title={current?.name ?? 'Dashboard'}
      description={description}
      size={editing ? 1360 : 1180}
      actions={
        editing ? (
          <>
            <Button
              type="button"
              variant="default"
              disabled={editor.cancelDisabled}
              onClick={cancelEditing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              leftSection={<IconCheck size={16} stroke={1.9} />}
              loading={editor.status.state === 'saving'}
              disabled={!editor.dirty || editor.locked}
              onClick={() => void saveEditing()}
            >
              Save changes
            </Button>
          </>
        ) : (
          <>
            <Tooltip label="Refresh all widgets" withArrow>
              <ActionIcon
                variant="default"
                size="input-sm"
                aria-label="Refresh all widgets"
                onClick={() => setRefreshSignal((signal) => signal + 1)}
              >
                <IconRefresh size={18} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
            {current ? <AutoRefreshMenu dashboard={current} /> : null}
            <Button
              type="button"
              variant="default"
              leftSection={<IconPencil size={16} stroke={1.8} />}
              onClick={beginEditing}
            >
              Edit dashboard
            </Button>
            {current ? <DashboardMenu dashboard={current} /> : null}
          </>
        )
      }
    >
      <Box>
        {editing ? (
          <>
            <Box className={classes.editorToolbar}>
              <Group justify="space-between" gap="md" wrap="wrap">
                <Group gap="md" wrap="wrap">
                  <DashboardLayoutPreview
                    value={previewBreakpoint}
                    onChange={setPreviewBreakpoint}
                  />
                  <DraftStatus
                    status={editor.status}
                    dirty={editor.dirty}
                    onCheckStatus={() => void checkSaveStatus()}
                  />
                </Group>
                <AddWidgetPicker
                  available={available}
                  placed={editor.draft.widgets}
                  opened={addWidgetOpened}
                  onOpenedChange={setAddWidgetOpened}
                  onAdd={editor.addWidget}
                  disabled={editor.locked}
                />
              </Group>
            </Box>
            <Box className={classes.previewStage}>
              <Box
                ref={measurePreviewViewport}
                className={classes.previewViewport}
              >
                <Box
                  className={classes.previewFrame}
                  style={{
                    width: scaledPreviewWidth,
                    height:
                      previewCanvasHeight > 0 ? scaledPreviewHeight : undefined,
                  }}
                >
                  <Box
                    ref={measurePreviewCanvas}
                    className={classes.previewCanvas}
                    style={{
                      width: previewTargetWidth,
                      transform: `scale(${previewScale})`,
                    }}
                    data-breakpoint={previewBreakpoint}
                    data-preview-scale={previewScale}
                  >
                    {grid}
                  </Box>
                </Box>
              </Box>
            </Box>
          </>
        ) : (
          grid
        )}
      </Box>
    </Page>
  );
}

function DraftStatus({
  status,
  dirty,
  onCheckStatus,
}: {
  status: DashboardDraftStatus;
  dirty: boolean;
  onCheckStatus: () => void;
}) {
  if (
    status.state === 'conflict' ||
    status.state === 'error' ||
    status.state === 'unknown'
  ) {
    return (
      <Group gap="xs" className={classes.draftError} wrap="wrap">
        <IconAlertCircle size={16} stroke={1.8} />
        <Text size="sm" fw={500}>
          {status.message}
        </Text>
        {status.state === 'unknown' ? (
          <Button
            type="button"
            variant="subtle"
            color="red"
            size="compact-xs"
            onClick={onCheckStatus}
          >
            Check status
          </Button>
        ) : null}
      </Group>
    );
  }

  const busy = status.state === 'saving' || status.state === 'checking';
  return (
    <Group gap={6} className={classes.draftStatus} aria-live="polite">
      {busy ? (
        <Loader size={14} />
      ) : dirty ? (
        <IconPencil size={15} stroke={1.8} />
      ) : (
        <IconCheck size={15} stroke={2} />
      )}
      <Text size="sm" c="dimmed">
        {status.state === 'saving'
          ? 'Saving changes'
          : status.state === 'checking'
            ? 'Checking save status'
            : dirty
              ? 'Unsaved changes'
              : 'No changes'}
      </Text>
    </Group>
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
      const next = dashboards.find((item) => item.id !== dashboard.id);
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
          Delete "{dashboard.name}"? Its widget layouts will be removed.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
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
  );
}
