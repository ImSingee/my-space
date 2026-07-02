import {
  ActionIcon,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  IconArrowRight,
  IconGripVertical,
  IconLayoutDashboard,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { SortableList, sortByIds } from '~components/app-shell/sortable-list';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { dashboardsQueryOptions } from '~queries/dashboards';
import {
  createDashboard,
  type Dashboard,
  deleteDashboard,
  renameDashboard,
  reorderDashboards,
  setDashboardPin,
} from '~server/dashboards';
import classes from './dashboards.module.css';

export const Route = createFileRoute('/_app/dashboards')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(dashboardsQueryOptions),
  component: DashboardsManagePage,
});

function DashboardsManagePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const create = useMutation({
    mutationFn: () => createDashboard({ data: { name: 'New dashboard' } }),
    onSuccess: (d) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => (old ? [...old, d] : [d]),
      );
      void invalidate();
      toast.success('Dashboard created');
    },
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameDashboard({ data: input }),
    onSuccess: () => {
      void invalidate();
      toast.success('Dashboard renamed');
    },
  });

  const openRename = (d: Dashboard) =>
    openTextPromptModal({
      title: 'Rename dashboard',
      label: 'Name',
      initialValue: d.name,
      onSubmit: (name) => rename.mutateAsync({ id: d.id, name }),
    });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setDashboardPin({ data: input }),
    onSuccess: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDashboard({ data: id }),
    onSuccess: () => {
      void invalidate();
      toast.success('Dashboard deleted');
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDashboards({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => sortByIds(old, orderedIds),
      );
    },
    onSettled: () => void invalidate(),
  });

  const list = dashboards ?? [];

  const confirmDelete = (d: Dashboard) =>
    modals.openConfirmModal({
      title: 'Delete dashboard',
      children: (
        <Text size="sm">
          Delete “{d.name}” and all of its widgets? This can’t be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(d.id),
    });

  return (
    <Page
      title="Dashboards"
      description="Create, organize, and pin the dashboards you use most."
      actions={
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          color="ember"
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          New dashboard
        </Button>
      }
    >
      <Stack gap={0}>
        <SortableList
          items={list}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(d) => (
            <div className={classes.row}>
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <IconGripVertical
                  size={18}
                  stroke={1.6}
                  style={{
                    cursor: 'grab',
                    color: 'var(--mantine-color-dimmed)',
                  }}
                />
                <ThemeIcon variant="light" color="ember" radius="md" size={34}>
                  <IconLayoutDashboard size={18} stroke={1.6} />
                </ThemeIcon>
                <Text fw={600} truncate>
                  {d.name}
                </Text>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Tooltip
                  label={d.pinned ? 'Pinned to sidebar' : 'Not pinned'}
                  withArrow
                >
                  <Switch
                    size="sm"
                    checked={d.pinned}
                    onChange={(e) =>
                      setPin.mutate({
                        id: d.id,
                        pinned: e.currentTarget.checked,
                      })
                    }
                    aria-label="Pin to sidebar"
                  />
                </Tooltip>
                <Tooltip label="Rename" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    onClick={() => openRename(d)}
                    aria-label="Rename dashboard"
                  >
                    <IconPencil size={17} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Delete" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    disabled={list.length <= 1}
                    onClick={() => confirmDelete(d)}
                    aria-label="Delete dashboard"
                  >
                    <IconTrash size={17} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Button
                  variant="light"
                  size="xs"
                  rightSection={<IconArrowRight size={15} stroke={1.8} />}
                  onClick={() =>
                    navigate({
                      to: '/dashboard/$dashboardId',
                      params: { dashboardId: d.id },
                    })
                  }
                >
                  Open
                </Button>
              </Group>
            </div>
          )}
        />
      </Stack>
    </Page>
  );
}
