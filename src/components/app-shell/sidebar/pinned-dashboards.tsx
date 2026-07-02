import { Menu, NavLink, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { IconLayoutDashboard, IconPlus } from '@tabler/icons-react';
import { toast } from 'sonner';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { dashboardsQueryOptions } from '~queries/dashboards';
import {
  type Dashboard,
  createDashboard,
  renameDashboard,
  reorderDashboards,
  setDashboardPin,
} from '~server/dashboards';
import { SortableList, sortByIds } from '../sortable-list';
import {
  AddActionButton,
  AddMenuButton,
  PinnedRow,
  SectionHeading,
  useIsActive,
} from './section';

export function PinnedDashboards() {
  const isActive = useIsActive();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setDashboardPin({ data: input }),
    onSuccess: () => void invalidate(),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameDashboard({ data: input }),
    onSuccess: () => {
      void invalidate();
      toast.success('Dashboard renamed');
    },
  });

  const openRename = (d: { id: string; name: string }) =>
    openTextPromptModal({
      title: 'Rename dashboard',
      label: 'Name',
      initialValue: d.name,
      onSubmit: (name) => rename.mutateAsync({ id: d.id, name }),
    });

  const create = useMutation({
    mutationFn: () => createDashboard({ data: { name: 'New dashboard' } }),
    onSuccess: (d: Dashboard) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => (old ? [...old, d] : [d]),
      );
      void invalidate();
      toast.success('Dashboard created');
      void navigate({
        to: '/dashboard/$dashboardId',
        params: { dashboardId: d.id },
      });
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDashboards({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(dashboardsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    onSettled: () => void invalidate(),
  });

  const all = dashboards ?? [];
  const pinned = all.filter((d) => d.pinned);
  const unpinned = all.filter((d) => !d.pinned);

  // Persist a sidebar reorder by mapping the new pinned order back into the
  // full list, leaving unpinned dashboards in their existing slots.
  const onReorder = (orderedPinnedIds: string[]) => {
    let pi = 0;
    const full = all.map((d) => (d.pinned ? orderedPinnedIds[pi++] : d.id));
    reorder.mutate(full);
  };

  const addControl =
    unpinned.length > 0 ? (
      <AddMenuButton label="Add dashboard" alwaysVisible={pinned.length === 0}>
        <Menu.Label>Pin a dashboard</Menu.Label>
        {unpinned.map((d) => (
          <Menu.Item
            key={d.id}
            leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
            disabled={setPin.isPending}
            onClick={() => setPin.mutate({ id: d.id, pinned: true })}
          >
            <Text size="sm" truncate>
              {d.name}
            </Text>
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconPlus size={16} stroke={1.6} />}
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          New dashboard
        </Menu.Item>
      </AddMenuButton>
    ) : (
      <AddActionButton
        label="New dashboard"
        alwaysVisible={pinned.length === 0}
        loading={create.isPending}
        onClick={() => create.mutate()}
      />
    );

  return (
    <>
      <SectionHeading
        label="Dashboards"
        addControl={addControl}
        manageTo="/dashboards"
        manageLabel="Manage dashboards"
      />
      <Stack gap={2} px="xs">
        <SortableList
          items={pinned}
          onReorder={onReorder}
          renderItem={(d) => (
            <PinnedRow
              onRename={() => openRename(d)}
              onUnpin={() => setPin.mutate({ id: d.id, pinned: false })}
            >
              <NavLink
                renderRoot={(props) => (
                  <Link
                    to="/dashboard/$dashboardId"
                    params={{ dashboardId: d.id }}
                    draggable={false}
                    {...props}
                  />
                )}
                label={d.name}
                leftSection={<IconLayoutDashboard size={18} stroke={1.6} />}
                active={isActive(`/dashboard/${d.id}`)}
                variant="light"
                pr={32}
              />
            </PinnedRow>
          )}
        />
      </Stack>
    </>
  );
}
