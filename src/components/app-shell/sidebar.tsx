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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useRouterState } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconDots,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconPencil,
  IconPinnedOff,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconSun,
} from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import {
  dashboardsQueryOptions,
  sidebarItemsQueryOptions,
  subappsQueryOptions,
} from '~queries/subapps';
import {
  renameDashboard,
  renameSidebarItem,
  reorderDashboards,
  reorderSidebarItems,
  setDashboardPin,
  setSidebarPin,
} from '~server/subapps';
import { Brand } from './brand';
import { SortableList, sortByIds } from './sortable-list';
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

/**
 * A pinned sidebar row: a full-width link with a kebab menu (revealed on hover)
 * exposing Rename / Unpin. The menu lives as an absolutely-positioned sibling of
 * the link so clicking it never triggers navigation.
 */
function PinnedRow({
  children,
  onRename,
  onUnpin,
}: {
  children: ReactNode;
  onRename: () => void;
  onUnpin: () => void;
}) {
  return (
    <Box className={classes.item}>
      {children}
      <Box className={classes.itemActionWrap}>
        <Menu position="bottom-end" withArrow shadow="md" width={160}>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              radius="sm"
              className={classes.itemAction}
              aria-label="Options"
            >
              <IconDots size={15} stroke={1.7} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconPencil size={15} stroke={1.7} />}
              onClick={onRename}
            >
              Rename
            </Menu.Item>
            <Menu.Item
              leftSection={<IconPinnedOff size={15} stroke={1.7} />}
              onClick={onUnpin}
            >
              Unpin
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Box>
    </Box>
  );
}

/** Small dimmed section header used to label sidebar groups. */
function SectionHeading({
  label,
  manageTo,
  manageLabel,
}: {
  label: string;
  manageTo?: string;
  manageLabel?: string;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" px="sm" mt="md" mb={4} gap={4}>
      <Text size="xs" fw={600} c="dimmed">
        {label}
      </Text>
      {manageTo ? (
        <Tooltip label={manageLabel} position="right" withArrow>
          <ActionIcon
            component={Link}
            to={manageTo}
            variant="subtle"
            color="gray"
            size="xs"
            radius="sm"
            aria-label={manageLabel}
          >
            <IconSettings size={14} stroke={1.7} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </Group>
  );
}

function PinnedDashboards() {
  const isActive = useIsActive();
  const queryClient = useQueryClient();
  const { data: dashboards } = useQuery(dashboardsQueryOptions);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: dashboardsQueryOptions.queryKey,
    });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setDashboardPin({ data: input }),
    onSuccess: () => void invalidate(),
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

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderDashboards({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(dashboardsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    onError: (error) => toast.error((error as Error).message),
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

  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      rename.mutate({ id: renameTarget.id, name: renameValue.trim() });
    }
  };

  return (
    <>
      <SectionHeading
        label="Dashboards"
        manageTo="/dashboards"
        manageLabel="Manage dashboards"
      />
      <Stack gap={2} px="xs">
        <SortableList
          items={pinned}
          onReorder={onReorder}
          renderItem={(d) => (
            <PinnedRow
              onRename={() => {
                setRenameTarget({ id: d.id, name: d.name });
                setRenameValue(d.name);
              }}
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
        {unpinned.length > 0 ? (
          <Menu position="right-start" withArrow shadow="md" width={240}>
            <Menu.Target>
              <NavLink
                component="button"
                type="button"
                label="Add dashboard"
                leftSection={<IconPlus size={18} stroke={1.6} />}
              />
            </Menu.Target>
            <Menu.Dropdown>
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
            </Menu.Dropdown>
          </Menu>
        ) : null}
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
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: sidebarItemsQueryOptions.queryKey,
    });

  const setPin = useMutation({
    mutationFn: (input: { subappId: string; pinned: boolean }) =>
      setSidebarPin({ data: input }),
    onSuccess: (_res, input) => {
      void invalidate();
      toast.success(input.pinned ? 'Pinned to sidebar' : 'Unpinned');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; label: string }) =>
      renameSidebarItem({ data: input }),
    onSuccess: () => {
      void invalidate();
      setRenameTarget(null);
      toast.success('Renamed');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderSidebarItems({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(sidebarItemsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    onError: (error) => toast.error((error as Error).message),
    onSettled: () => void invalidate(),
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

  const submitRename = () => {
    if (renameTarget && renameValue.trim()) {
      rename.mutate({ id: renameTarget.id, label: renameValue.trim() });
    }
  };

  return (
    <>
      <SectionHeading
        label="Apps"
        manageTo="/subapps"
        manageLabel="Manage apps"
      />
      <Stack gap={2} px="xs">
        <SortableList
          items={pins ?? []}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(pin) => (
            <PinnedRow
              onRename={() => {
                setRenameTarget({ id: pin.id, label: pin.label });
                setRenameValue(pin.label);
              }}
              onUnpin={() =>
                setPin.mutate({ subappId: pin.subappId, pinned: false })
              }
            >
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
                pr={32}
              />
            </PinnedRow>
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
                  disabled={setPin.isPending}
                  onClick={() =>
                    setPin.mutate({ subappId: s.id, pinned: true })
                  }
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

      <Modal
        opened={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename app"
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
            renderRoot={(props) => <Link to="/agent" {...props} />}
            label="Agent"
            leftSection={<IconSparkles size={18} stroke={1.6} />}
            active={isActive('/agent')}
            variant="light"
          />
        </Stack>
        <PinnedDashboards />
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
