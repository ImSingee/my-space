import {
  ActionIcon,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  TextInput,
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
import { useState } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { SortableList, sortByIds } from '~components/app-shell/sortable-list';
import { dashboardsQueryOptions } from '~queries/subapps';
import {
  createDashboard,
  type Dashboard,
  deleteDashboard,
  renameDashboard,
  reorderDashboards,
  setDashboardPin,
} from '~server/subapps';

export const Route = createFileRoute('/_app/dashboards')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(dashboardsQueryOptions),
  component: DashboardsManagePage,
});

function DashboardsManagePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);
  const [renameTarget, setRenameTarget] = useState<Dashboard | null>(null);
  const [renameValue, setRenameValue] = useState('');

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
    onError: (error) => toast.error((error as Error).message),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameDashboard({ data: input }),
    onSuccess: () => {
      void invalidate();
      setRenameTarget(null);
      toast.success('Dashboard renamed');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setDashboardPin({ data: input }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDashboard({ data: id }),
    onSuccess: () => {
      void invalidate();
      toast.success('Dashboard deleted');
    },
    onError: (error) => toast.error((error as Error).message),
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
    onError: (error) => toast.error((error as Error).message),
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

  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      rename.mutate({ id: renameTarget.id, name: renameValue.trim() });
    }
  };

  return (
    <Page
      title="Dashboards"
      description="Create, organize, and pin the dashboards you use most."
      actions={
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          color="violet"
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          New dashboard
        </Button>
      }
    >
      <Stack gap="xs">
        <SortableList
          items={list}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(d) => (
            <Card withBorder padding="sm" radius="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <IconGripVertical
                    size={18}
                    stroke={1.6}
                    style={{
                      cursor: 'grab',
                      color: 'var(--mantine-color-dimmed)',
                    }}
                  />
                  <ThemeIcon
                    variant="light"
                    color="violet"
                    radius="md"
                    size={34}
                  >
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
                      onClick={() => {
                        setRenameTarget(d);
                        setRenameValue(d.name);
                      }}
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
              </Group>
            </Card>
          )}
        />
      </Stack>

      <Modal
        opened={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename dashboard"
        centered
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            label="Name"
            value={renameValue}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
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
              color="violet"
              loading={rename.isPending}
              disabled={!renameValue.trim()}
              onClick={submitRename}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Page>
  );
}
