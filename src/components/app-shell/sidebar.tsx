import {
  ActionIcon,
  Avatar,
  Box,
  Button,
  Group,
  Menu,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconAppWindow,
  IconDots,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconPencil,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconStack2,
  IconSun,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import {
  dashboardsQueryOptions,
  sidebarItemsQueryOptions,
  subappsQueryOptions,
} from '~queries/subapps';
import {
  createDashboard,
  type Dashboard,
  deleteDashboard,
  renameDashboard,
  reorderDashboards,
  reorderSidebarItems,
  setSidebarPin,
} from '~server/subapps';
import { Brand } from './brand';
import { SortableList } from './sortable-list';
import classes from './sidebar.module.css';

function useIsActive() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (to: string) => pathname === to || pathname.startsWith(`${to}/`);
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', {
    getInitialValueInEffect: true,
  });
  const next = computed === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip label={`Switch to ${next} mode`} position="top" withArrow>
      <ActionIcon
        variant="default"
        size="lg"
        radius="md"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(next)}
      >
        {computed === 'dark' ? (
          <IconSun size={18} stroke={1.6} />
        ) : (
          <IconMoon size={18} stroke={1.6} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

function UserMenu() {
  const router = useRouter();
  const { data } = authClient.useSession();
  const email = data?.user.email ?? 'account';
  const name = data?.user.name || email;

  const signOut = async () => {
    await authClient.signOut();
    toast.success('Signed out');
    await router.navigate({ to: '/login' });
  };

  return (
    <Menu position="top-end" width={220} withArrow shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          radius="md"
          aria-label="Account menu"
        >
          <Avatar size={28} radius="xl" name={name} color="violet" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="xs" truncate>
            {email}
          </Text>
        </Menu.Label>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function DashboardItem({
  dashboard,
  active,
  canDelete,
  onRename,
  onDelete,
}: {
  dashboard: Dashboard;
  active: boolean;
  canDelete: boolean;
  onRename: (d: Dashboard) => void;
  onDelete: (d: Dashboard) => void;
}) {
  const [menuOpened, setMenuOpened] = useState(false);
  return (
    <Box className={classes.item}>
      <NavLink
        renderRoot={(props) => (
          <Link
            to="/dashboard/$dashboardId"
            params={{ dashboardId: dashboard.id }}
            draggable={false}
            {...props}
          />
        )}
        label={dashboard.name}
        leftSection={<IconLayoutDashboard size={18} stroke={1.6} />}
        active={active}
        variant="light"
        pr={32}
      />
      <Box className={classes.itemActionWrap}>
        <Menu
          position="bottom-end"
          withArrow
          shadow="md"
          width={150}
          onChange={setMenuOpened}
        >
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              radius="sm"
              className={classes.itemAction}
              data-open={menuOpened || undefined}
              aria-label="Dashboard actions"
            >
              <IconDots size={15} stroke={1.7} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconPencil size={14} />}
              onClick={() => onRename(dashboard)}
            >
              Rename
            </Menu.Item>
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={!canDelete}
              onClick={() => onDelete(dashboard)}
            >
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Box>
    </Box>
  );
}

function DashboardsNav() {
  const isActive = useIsActive();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);

  const [renameTarget, setRenameTarget] = useState<Dashboard | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const create = useMutation({
    mutationFn: () => createDashboard({ data: { name: 'New dashboard' } }),
    onSuccess: (d) => {
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        (old) => (old ? [...old, d] : [d]),
      );
      void queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      });
      void navigate({
        to: '/dashboard/$dashboardId',
        params: { dashboardId: d.id },
      });
      toast.success('Dashboard created');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDashboards({ data: orderedIds }),
    onError: (error) => toast.error((error as Error).message),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameDashboard({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      });
      setRenameTarget(null);
      toast.success('Dashboard renamed');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDashboard({ data: id }),
    onSuccess: (_res, id) => {
      const remaining = (
        queryClient.getQueryData<Dashboard[]>(
          dashboardsQueryOptions.queryKey,
        ) ?? []
      ).filter((d) => d.id !== id);
      queryClient.setQueryData<Dashboard[]>(
        dashboardsQueryOptions.queryKey,
        remaining,
      );
      void queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      });
      if (pathname === `/dashboard/${id}`) {
        const next = remaining[0]?.id;
        void (next
          ? navigate({
              to: '/dashboard/$dashboardId',
              params: { dashboardId: next },
            })
          : navigate({ to: '/dashboard' }));
      }
      toast.success('Dashboard deleted');
    },
    onError: (error) => toast.error((error as Error).message),
  });

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

  const openRename = (d: Dashboard) => {
    setRenameTarget(d);
    setRenameValue(d.name);
  };

  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      rename.mutate({ id: renameTarget.id, name: renameValue.trim() });
    }
  };

  const list = dashboards ?? [];

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" px="sm" mt="md" mb={4}>
        Dashboards
      </Text>
      <Stack gap={2} px="xs">
        <SortableList
          items={list}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(d) => (
            <DashboardItem
              dashboard={d}
              active={isActive(`/dashboard/${d.id}`)}
              canDelete={list.length > 1}
              onRename={openRename}
              onDelete={confirmDelete}
            />
          )}
        />
        <NavLink
          component="button"
          type="button"
          label="Add dashboard"
          leftSection={<IconPlus size={18} stroke={1.6} />}
          disabled={create.isPending}
          onClick={() => create.mutate()}
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
    </>
  );
}

function PinnedApps() {
  const isActive = useIsActive();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: subapps } = useQuery(subappsQueryOptions);

  const pinApp = useMutation({
    mutationFn: (subappId: string) =>
      setSidebarPin({ data: { subappId, pinned: true } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      });
      toast.success('Pinned to sidebar');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderSidebarItems({ data: orderedIds }),
    onError: (error) => toast.error((error as Error).message),
  });

  const pinnedIds = new Set((pins ?? []).map((p) => p.subappId));
  // Only deployed apps with a frontend can be opened from the sidebar.
  const candidates = (subapps ?? []).filter(
    (s) =>
      s.status === 'deployed' &&
      Boolean(s.capabilities?.frontend) &&
      !pinnedIds.has(s.id),
  );

  if ((pins?.length ?? 0) === 0 && candidates.length === 0) return null;

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" px="sm" mt="md" mb={4}>
        Pinned apps
      </Text>
      <Stack gap={2} px="xs">
        <SortableList
          items={pins ?? []}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(pin) => (
            <NavLink
              renderRoot={(props) => (
                <Link
                  to="/apps/$subappId"
                  params={{ subappId: pin.subappId }}
                  draggable={false}
                  {...props}
                />
              )}
              label={pin.label}
              leftSection={<IconAppWindow size={18} stroke={1.6} />}
              active={isActive(`/apps/${pin.subappId}`)}
              variant="light"
            />
          )}
        />
        {candidates.length > 0 ? (
          <Menu position="right-start" withArrow shadow="md" width={240}>
            <Menu.Target>
              <NavLink
                component="button"
                type="button"
                label="Add app"
                leftSection={<IconPlus size={18} stroke={1.6} />}
              />
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Pin a deployed app</Menu.Label>
              {candidates.map((s) => (
                <Menu.Item
                  key={s.id}
                  leftSection={<IconAppWindow size={16} stroke={1.6} />}
                  disabled={pinApp.isPending}
                  onClick={() => pinApp.mutate(s.id)}
                >
                  <Text size="sm" truncate>
                    {s.name}
                  </Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        ) : null}
      </Stack>
    </>
  );
}

export function Sidebar() {
  const isActive = useIsActive();

  return (
    <Box className={classes.root}>
      <Box className={classes.head}>
        <Brand />
      </Box>

      <ScrollArea className={classes.nav} type="scroll" scrollbarSize={6}>
        <Stack gap={2} px="xs" mt={4}>
          <NavLink
            renderRoot={(props) => <Link to="/subapps" {...props} />}
            label="Subapps"
            leftSection={<IconStack2 size={18} stroke={1.6} />}
            active={isActive('/subapps')}
            variant="light"
          />
          <NavLink
            renderRoot={(props) => <Link to="/agent" {...props} />}
            label="Agent"
            leftSection={<IconSparkles size={18} stroke={1.6} />}
            active={isActive('/agent')}
            variant="light"
          />
        </Stack>
        <DashboardsNav />
        <PinnedApps />
      </ScrollArea>

      <Box className={classes.footer}>
        <NavLink
          renderRoot={(props) => <Link to="/settings" {...props} />}
          label="Settings"
          leftSection={<IconSettings size={18} stroke={1.6} />}
          active={isActive('/settings')}
          variant="light"
          mb="2xs"
        />
        <Group justify="space-between" px="xs">
          <UserMenu />
          <ColorSchemeToggle />
        </Group>
      </Box>
    </Box>
  );
}
