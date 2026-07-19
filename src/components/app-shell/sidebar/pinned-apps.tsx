import {
  Button,
  Group,
  Menu,
  Modal,
  NavLink,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { IconAppWindow, IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import {
  appsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import {
  addSidebarItem,
  removeSidebarItem,
  reorderSidebarItems,
  setSidebarPin,
  updateSidebarItem,
} from '~server/sidebar';
import { SortableList, sortByIds } from '../sortable-list';
import {
  AddActionButton,
  AddMenuButton,
  PinnedRow,
  SectionHeading,
  useIsActive,
} from './section';

export function PinnedApps() {
  const isActive = useIsActive();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    appId: string;
  } | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editHash, setEditHash] = useState('');
  const editedAppId = editTarget?.appId ?? '';
  const { data: editedManifest } = useQuery({
    ...normalizedManifestQueryOptions(editedAppId),
    enabled: Boolean(editedAppId),
  });

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
  });

  // Extra shortcut for an already-pinned app: always inserts a new pin, then
  // jumps into editing so it can be given a distinct name/entry point.
  const add = useMutation({
    mutationFn: (appId: string) => addSidebarItem({ data: { appId } }),
    onSuccess: (row) => {
      void invalidate();
      if (row) {
        setEditTarget({ id: row.id, appId: row.appId });
        setEditLabel(row.label);
        setEditHash('');
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeSidebarItem({ data: { id } }),
    onSuccess: () => {
      void invalidate();
      toast.success('Unpinned');
    },
  });

  const update = useMutation({
    mutationFn: (input: { id: string; label: string; entryHash: string }) =>
      updateSidebarItem({ data: input }),
    onSuccess: () => {
      void invalidate();
      setEditTarget(null);
      toast.success('Pin updated');
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderSidebarItems({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(sidebarItemsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    onSettled: () => void invalidate(),
  });

  if (!pins?.length) return null;

  // Only deployed apps with a frontend can be opened from the sidebar.
  const openable = (apps ?? []).filter(
    (s) => s.status === 'deployed' && Boolean(s.capabilities?.frontend),
  );
  const pinnedIds = new Set(pins.map((p) => p.appId));
  const unpinnedApps = openable.filter((s) => !pinnedIds.has(s.id));
  const pinnedApps = openable.filter((s) => pinnedIds.has(s.id));

  // How many pins each app has, so a pin only needs hash-aware highlighting
  // when its app is pinned more than once (single pins stay active app-wide).
  const pinCountByApp = new Map<string, number>();
  for (const p of pins) {
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

  const addControl =
    openable.length > 0 ? (
      <AddMenuButton label="Add app" alwaysVisible={false}>
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
      </AddMenuButton>
    ) : (
      <AddActionButton
        label="Create an app with the Agent"
        alwaysVisible={false}
        onClick={goCreateApp}
      />
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
          items={pins}
          onReorder={(ids) => reorder.mutate(ids)}
          renderItem={(pin) => (
            <PinnedRow
              renameLabel="Edit"
              onRename={() => {
                setEditTarget({ id: pin.id, appId: pin.appId });
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
          <AppRouteAutocomplete
            routes={editedManifest?.app?.routes ?? []}
            label="Entry point"
            description="Open the app at a specific page. Leave blank for the app home."
            placeholder="/settings"
            value={editHash}
            onChange={setEditHash}
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
