import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowLeft,
  IconCheck,
  IconDotsVertical,
  IconExternalLink,
  IconFileZip,
  IconGitBranch,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { ApiPanel } from '~components/apps/api-panel';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeploymentHistory } from '~components/apps/deployment-history';
import { OperationsPanel } from '~components/apps/operations-panel';
import { Field } from '~components/system/field';
import { StatusBadge } from '~components/system/status-badge';
import { appOpsQueryOptions, appsQueryOptions } from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { archiveAppFn, deleteAppFn, getApp, setAppSlugFn } from '~server/apps';
import { setSidebarPin } from '~server/sidebar';

export const Route = createFileRoute('/_app/apps/$appId/manage')({
  loader: async ({ params }) => {
    const app = await getApp({ data: params.appId });
    if (!app) {
      throw notFound();
    }
    return app;
  },
  component: AppDetailPage,
});

function AppDetailPage() {
  const app = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const isPinned = Boolean(pins?.some((p) => p.appId === app.id));
  const capabilities = app.capabilities ?? null;
  const hasFrontend = Boolean(capabilities?.frontend);

  const isArchived = app.status === 'archived';
  // Source only lands on `master` once an app has been deployed at least once.
  const hasSource = Boolean(app.currentSourceCommit);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveAppFn({ data: { id: app.id, archived } }),
    onSuccess: (_result, archived) => {
      toast.success(archived ? 'App archived' : 'App restored');
      // Archiving stops the backend/cron/storage; restoring re-enables them. The
      // Operations panel reads appOpsQueryOptions, so invalidate it too or it
      // keeps showing pre-toggle running/idle state until a later refetch.
      void queryClient.invalidateQueries(appOpsQueryOptions(app.id));
      void router.invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteAppFn({ data: app.id }),
    onSuccess: () => {
      toast.success(`Deleted ${app.name}`);
      // The delete cascades to sidebar pins, so drop those caches too; otherwise
      // the deleted app lingers in the sidebar / pin menu and links to a 404
      // until the next focus refetch.
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: appsQueryOptions.queryKey,
      });
      void navigate({ to: '/apps' });
    },
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setSidebarPin({ data: { appId: app.id, pinned } }),
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? 'Pinned to sidebar' : 'Removed from sidebar');
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      });
    },
  });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: `Delete ${app.name}?`,
      children: (
        <Text size="sm">
          This permanently removes the app, its database, all deployments, and
          dashboard widgets. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete app', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
    <Page
      title={
        <Group gap="sm" align="center" wrap="nowrap">
          <AppGlyph name={app.name} seed={app.id} size="md" />
          {app.name}
          <StatusBadge status={app.status} />
        </Group>
      }
      description={app.description || `App · ${app.slug}`}
      actions={
        <>
          <Button
            component={Link}
            to="/apps"
            variant="default"
            leftSection={<IconArrowLeft size={16} stroke={1.8} />}
          >
            Back
          </Button>
          {hasFrontend ? (
            <Button
              renderRoot={(props) => (
                <Link to="/apps/$appId" params={{ appId: app.id }} {...props} />
              )}
              disabled={app.status !== 'deployed'}
              leftSection={<IconExternalLink size={16} stroke={1.8} />}
            >
              Open app
            </Button>
          ) : null}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size="lg" aria-label="More actions">
                <IconDotsVertical size={18} stroke={1.8} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Download</Menu.Label>
              <Menu.Item
                leftSection={<IconFileZip size={16} />}
                component="a"
                href={`/api/apps/${app.id}/download?mode=source`}
                download
                disabled={!hasSource}
              >
                Latest source (.zip)
              </Menu.Item>
              <Menu.Item
                leftSection={<IconGitBranch size={16} />}
                component="a"
                href={`/api/apps/${app.id}/download?mode=repo`}
                download
                disabled={!hasSource}
              >
                Full repo (.tar.gz)
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={
                  isPinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />
                }
                onClick={() => pin.mutate(!isPinned)}
              >
                {isPinned ? 'Remove from sidebar' : 'Pin to sidebar'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={
                  isArchived ? (
                    <IconArchiveOff size={16} />
                  ) : (
                    <IconArchive size={16} />
                  )
                }
                onClick={() => archive.mutate(!isArchived)}
              >
                {isArchived ? 'Restore from archive' : 'Archive'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={confirmDelete}
              >
                Delete app
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </>
      }
    >
      <Stack gap="xl">
        <Box component="section">
          <Text fw={600} fz="lg" mb="md">
            Overview
          </Text>

          <Stack gap="sm">
            <SlugField appId={app.id} slug={app.slug} />
            <Field label="App ID" value={app.id} mono copyValue={app.id} />
            <Field
              label="Updated"
              value={dayjs(app.updatedAt).format('YYYY-MM-DD HH:mm')}
            />
          </Stack>

          <Text size="sm" c="dimmed" mt="lg">
            Continue editing this app from the{' '}
            <Anchor component={Link} to="/agent">
              Agent
            </Anchor>
            .
          </Text>
        </Box>

        <Divider />

        <OperationsPanel
          appId={app.id}
          dbName={app.dbName ?? null}
          dbEnabled={Boolean(capabilities?.database) || Boolean(app.dbName)}
        />

        {capabilities?.backend ? (
          <>
            <Divider />
            <ApiPanel appId={app.id} />
          </>
        ) : null}

        <Divider />

        <DeploymentHistory appId={app.id} />
      </Stack>
    </Page>
  );
}

/**
 * Editable URL-slug row. The slug is the only part of an app's identity that
 * users can change; it appears in the shareable `/app/<slug>/` URL and renaming
 * it never requires a rebuild (everything technical is keyed off the immutable
 * id).
 */
function SlugField({ appId, slug }: { appId: string; slug: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slug);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (next: string) =>
      setAppSlugFn({ data: { id: appId, slug: next } }),
    onSuccess: (result) => {
      toast.success(`URL slug is now "${result.slug}"`);
      setEditing(false);
      void queryClient.invalidateQueries({
        queryKey: appsQueryOptions.queryKey,
      });
      // The route may have been opened with the (now stale) old slug as its
      // param; pin the URL to the immutable id before reloading so the loader
      // doesn't refetch a slug that no longer resolves and 404.
      void navigate({
        to: '/apps/$appId/manage',
        params: { appId },
        replace: true,
      });
      void router.invalidate();
    },
  });

  const submit = () => {
    const next = draft.trim();
    if (next === slug) {
      setEditing(false);
      return;
    }
    save.mutate(next);
  };

  return (
    <Group gap="md" wrap="nowrap" align="center">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        URL slug
      </Text>
      {editing ? (
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                setDraft(slug);
                setEditing(false);
              }
            }}
            size="xs"
            disabled={save.isPending}
            styles={{ input: { fontFamily: 'monospace' } }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Tooltip label="Save" withArrow position="top">
            <ActionIcon
              variant="light"
              color="green"
              onClick={submit}
              loading={save.isPending}
              aria-label="Save slug"
            >
              <IconCheck size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Cancel" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(false);
              }}
              disabled={save.isPending}
              aria-label="Cancel"
            >
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ) : (
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" ff="monospace" truncate>
            {slug}
          </Text>
          <Tooltip label="Open app" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              component="a"
              href={`/app/${slug}/`}
              target="_blank"
              aria-label="Open app"
            >
              <IconExternalLink size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Edit slug" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(true);
              }}
              aria-label="Edit slug"
            >
              <IconPencil size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </Group>
  );
}
