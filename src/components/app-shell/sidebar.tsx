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
  IconPinnedOff,
  IconPlus,
  IconRepeat,
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
  appsQueryOptions,
} from '~queries/apps';
import {
  type Dashboard,
  addSidebarItem,
  createDashboard,
  removeSidebarItem,
  renameDashboard,
  reorderDashboards,
  reorderSidebarItems,
  setDashboardPin,
  setSidebarPin,
  updateSidebarItem,
} from '~server/apps';
import { workflowsQueryOptions } from '~queries/workflows';
import { setWorkflowPinFn } from '~server/workflows';
import { AppGlyph } from '~components/apps/app-glyph';
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
    <Menu
      position="top-end"
      width={220}
      withArrow
      shadow="md"
      trigger="click-hover"
      openDelay={100}
      closeDelay={200}
    >
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          radius="md"
          aria-label="Account menu"
        >
          <Avatar size={28} radius="xl" name={name} />
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
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Dashboards
        </Menu.Item>
        <Menu.Item
          leftSection={<IconAppWindow size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/apps" {...props} />}
        >
          Apps
        </Menu.Item>
        <Menu.Item
          leftSection={<IconSettings size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings" {...props} />}
        >
          Settings
        </Menu.Item>
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
  renameLabel = 'Rename',
}: {
  children: ReactNode;
  onRename: () => void;
  onUnpin: () => void;
  /** Label for the first (edit) menu item; defaults to "Rename". */
  renameLabel?: string;
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
              {renameLabel}
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
  addControl,
  manageTo,
  manageLabel,
}: {
  label: string;
  addControl?: ReactNode;
  manageTo?: string;
  manageLabel?: string;
}) {
  return (
    <Group
      className={classes.sectionHeader}
      justify="space-between"
      wrap="nowrap"
      px="sm"
      mt="md"
      mb={4}
      gap={4}
    >
      <Text className={classes.sectionLabel}>{label}</Text>
      {addControl || manageTo ? (
        <Group gap={2} wrap="nowrap">
          {addControl}
          {manageTo ? (
            <Tooltip label={manageLabel} position="top" withArrow>
              <ActionIcon
                className={classes.actionButton}
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
      ) : null}
    </Group>
  );
}

function PinnedDashboards() {
  const isActive = useIsActive();
  const navigate = useNavigate();
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

  const addBtnClass =
    pinned.length === 0
      ? `${classes.actionButton} ${classes.actionButtonStatic}`
      : classes.actionButton;

  const addControl =
    unpinned.length > 0 ? (
      <Menu position="right-start" withArrow shadow="md" width={240}>
        <Menu.Target>
          <ActionIcon
            className={addBtnClass}
            variant="subtle"
            color="gray"
            size="xs"
            radius="sm"
            aria-label="Add dashboard"
          >
            <IconPlus size={14} stroke={1.8} />
          </ActionIcon>
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
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconPlus size={16} stroke={1.6} />}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            New dashboard
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    ) : (
      <Tooltip label="New dashboard" position="top" withArrow>
        <ActionIcon
          className={addBtnClass}
          variant="subtle"
          color="gray"
          size="xs"
          radius="sm"
          aria-label="New dashboard"
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          <IconPlus size={14} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  const [editTarget, setEditTarget] = useState<{ id: string } | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editHash, setEditHash] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: sidebarItemsQueryOptions.queryKey,
    });

  const hostHash = useRouterState({ select: (s) => s.location.hash });

  // First-time pin: idempotent (server uses an advisory lock) so a double-click
  // on an unpinned app can't create duplicate root shortcuts.
  const pin = useMutation({
    mutationFn: (appId: string) =>
      setSidebarPin({ data: { appId, pinned: true } }),
    onSuccess: () => {
      void invalidate();
      toast.success('Pinned to sidebar');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  // Extra shortcut for an already-pinned app: always inserts a new pin, then
  // jumps into editing so it can be given a distinct name/entry point.
  const add = useMutation({
    mutationFn: (appId: string) => addSidebarItem({ data: { appId } }),
    onSuccess: (row) => {
      void invalidate();
      if (row) {
        setEditTarget({ id: row.id });
        setEditLabel(row.label);
        setEditHash('');
      }
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeSidebarItem({ data: { id } }),
    onSuccess: () => {
      void invalidate();
      toast.success('Unpinned');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; label: string; entryHash: string }) =>
      updateSidebarItem({ data: input }),
    onSuccess: () => {
      void invalidate();
      setEditTarget(null);
      toast.success('Pin updated');
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

  // Only deployed apps with a frontend can be opened from the sidebar.
  const openable = (apps ?? []).filter(
    (s) => s.status === 'deployed' && Boolean(s.capabilities?.frontend),
  );
  const pinnedIds = new Set((pins ?? []).map((p) => p.appId));
  const unpinnedApps = openable.filter((s) => !pinnedIds.has(s.id));
  const pinnedApps = openable.filter((s) => pinnedIds.has(s.id));

  // How many pins each app has, so a pin only needs hash-aware highlighting
  // when its app is pinned more than once (single pins stay active app-wide).
  const pinCountByApp = new Map<string, number>();
  for (const p of pins ?? []) {
    pinCountByApp.set(p.appId, (pinCountByApp.get(p.appId) ?? 0) + 1);
  }
  const isPinActive = (pin: { appId: string; entryHash: string | null }) => {
    if (!isActive(`/apps/${pin.appId}`)) return false;
    if ((pinCountByApp.get(pin.appId) ?? 0) <= 1) return true;
    return hostHash === (pin.entryHash ?? '');
  };

  const submitEdit = () => {
    if (editTarget && editLabel.trim()) {
      update.mutate({
        id: editTarget.id,
        label: editLabel.trim(),
        entryHash: editHash,
      });
    }
  };

  const goCreateApp = () => {
    toast.info('Create a new app by chatting with the Agent');
    void navigate({ to: '/agent' });
  };

  const addBtnClass =
    (pins?.length ?? 0) === 0
      ? `${classes.actionButton} ${classes.actionButtonStatic}`
      : classes.actionButton;

  const addControl =
    openable.length > 0 ? (
      <Menu position="right-start" withArrow shadow="md" width={240}>
        <Menu.Target>
          <ActionIcon
            className={addBtnClass}
            variant="subtle"
            color="gray"
            size="xs"
            radius="sm"
            aria-label="Add app"
          >
            <IconPlus size={14} stroke={1.8} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {unpinnedApps.length > 0 ? (
            <>
              <Menu.Label>Pin a deployed app</Menu.Label>
              {unpinnedApps.map((s) => (
                <Menu.Item
                  key={s.id}
                  leftSection={<IconAppWindow size={16} stroke={1.6} />}
                  disabled={pin.isPending}
                  onClick={() => pin.mutate(s.id)}
                >
                  <Text size="sm" truncate>
                    {s.name}
                  </Text>
                </Menu.Item>
              ))}
            </>
          ) : null}
          {pinnedApps.length > 0 ? (
            <>
              <Menu.Label>Add another shortcut</Menu.Label>
              {pinnedApps.map((s) => (
                <Menu.Item
                  key={s.id}
                  leftSection={<IconAppWindow size={16} stroke={1.6} />}
                  disabled={add.isPending}
                  onClick={() => add.mutate(s.id)}
                >
                  <Text size="sm" truncate>
                    {s.name}
                  </Text>
                </Menu.Item>
              ))}
            </>
          ) : null}
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconSparkles size={16} stroke={1.6} />}
            onClick={goCreateApp}
          >
            New app with Agent
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    ) : (
      <Tooltip label="Create an app with the Agent" position="top" withArrow>
        <ActionIcon
          className={addBtnClass}
          variant="subtle"
          color="gray"
          size="xs"
          radius="sm"
          aria-label="Create an app with the Agent"
          onClick={goCreateApp}
        >
          <IconPlus size={14} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
    );

  return (
    <>
      <SectionHeading
        label="Apps"
        addControl={addControl}
        manageTo="/apps"
        manageLabel="Manage apps"
      />
      <Stack gap={2} px="xs">
        <SortableList
          items={pins ?? []}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(pin) => (
            <PinnedRow
              renameLabel="Edit"
              onRename={() => {
                setEditTarget({ id: pin.id });
                setEditLabel(pin.label);
                setEditHash(pin.entryHash ?? '');
              }}
              onUnpin={() => remove.mutate(pin.id)}
            >
              <NavLink
                renderRoot={(props) => (
                  <Link
                    to="/apps/$appId"
                    params={{ appId: pin.appId }}
                    hash={pin.entryHash ?? undefined}
                    draggable={false}
                    {...props}
                  />
                )}
                label={pin.label}
                leftSection={
                  <AppGlyph name={pin.label} seed={pin.appId} size="sm" />
                }
                active={isPinActive(pin)}
                variant="light"
                pr={32}
              />
            </PinnedRow>
          )}
        />
      </Stack>

      <Modal
        opened={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit pin"
        centered
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            label="Name"
            value={editLabel}
            onChange={(e) => setEditLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <TextInput
            label="Entry point"
            description="Open the app at a specific page. Leave blank for the app home."
            placeholder="/settings"
            value={editHash}
            onChange={(e) => setEditHash(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <Group justify="flex-end">
            <Button
              type="button"
              loading={update.isPending}
              disabled={!editLabel.trim()}
              onClick={submitEdit}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function PinnedWorkflows() {
  const isActive = useIsActive();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: workflows } = useQuery(workflowsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: workflowsQueryOptions.queryKey,
    });

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setWorkflowPinFn({ data: input }),
    onSuccess: (_res, input) => {
      void invalidate();
      toast.success(input.pinned ? 'Pinned to sidebar' : 'Unpinned');
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const all = workflows ?? [];
  const pinned = all.filter((w) => w.pinned);
  const candidates = all.filter((w) => !w.pinned);

  const goCreate = () => {
    toast.info('Create a new workflow by chatting with the Agent');
    void navigate({ to: '/agent' });
  };

  const addBtnClass =
    pinned.length === 0
      ? `${classes.actionButton} ${classes.actionButtonStatic}`
      : classes.actionButton;

  const addControl =
    candidates.length > 0 ? (
      <Menu position="right-start" withArrow shadow="md" width={240}>
        <Menu.Target>
          <ActionIcon
            className={addBtnClass}
            variant="subtle"
            color="gray"
            size="xs"
            radius="sm"
            aria-label="Add workflow"
          >
            <IconPlus size={14} stroke={1.8} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Pin a workflow</Menu.Label>
          {candidates.map((w) => (
            <Menu.Item
              key={w.id}
              leftSection={<IconRepeat size={16} stroke={1.6} />}
              disabled={setPin.isPending}
              onClick={() => setPin.mutate({ id: w.id, pinned: true })}
            >
              <Text size="sm" truncate>
                {w.name}
              </Text>
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconSparkles size={16} stroke={1.6} />}
            onClick={goCreate}
          >
            New workflow with Agent
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    ) : (
      <Tooltip
        label="Create a workflow with the Agent"
        position="top"
        withArrow
      >
        <ActionIcon
          className={addBtnClass}
          variant="subtle"
          color="gray"
          size="xs"
          radius="sm"
          aria-label="Create a workflow with the Agent"
          onClick={goCreate}
        >
          <IconPlus size={14} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
    );

  return (
    <>
      <SectionHeading
        label="Workflows"
        addControl={addControl}
        manageTo="/workflows"
        manageLabel="Manage workflows"
      />
      <Stack gap={2} px="xs">
        {pinned.map((w) => (
          <Box key={w.id} className={classes.item}>
            <NavLink
              renderRoot={(props) => (
                <Link
                  to="/workflows/$workflowId"
                  params={{ workflowId: w.id }}
                  {...props}
                />
              )}
              label={w.name}
              leftSection={<AppGlyph name={w.name} seed={w.id} size="sm" />}
              active={isActive(`/workflows/${w.id}`)}
              variant="light"
              pr={32}
            />
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
                    leftSection={<IconPinnedOff size={15} stroke={1.7} />}
                    onClick={() => setPin.mutate({ id: w.id, pinned: false })}
                  >
                    Unpin
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Box>
          </Box>
        ))}
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
            renderRoot={(props) => <Link to="/agent" {...props} />}
            label="Agent"
            leftSection={<IconSparkles size={18} stroke={1.6} />}
            active={isActive('/agent')}
            variant="light"
          />
        </Stack>
        <PinnedDashboards />
        <PinnedApps />
        <PinnedWorkflows />
      </ScrollArea>

      <Box className={classes.footer}>
        <Group justify="space-between" px="xs">
          <UserMenu />
          <ColorSchemeToggle />
        </Group>
      </Box>
    </Box>
  );
}
