import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Text,
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
  IconDotsVertical,
  IconExternalLink,
  IconPin,
  IconPinnedOff,
  IconRocket,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import { CapabilitiesPanel } from '~components/apps/capabilities-panel';
import { DeploymentHistory } from '~components/apps/deployment-history';
import { StatusBadge } from '~components/apps/status-badge';
import { sidebarItemsQueryOptions } from '~queries/apps';
import type { AppCapabilities } from '~/db/schema';
import {
  archiveAppFn,
  deleteAppFn,
  deployAppFn,
  getApp,
  setSidebarPin,
} from '~server/apps';

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

const CAPABILITY_LABELS: Record<keyof AppCapabilities, string> = {
  frontend: 'Frontend',
  widgets: 'Widgets',
  backend: 'Backend',
  database: 'Database',
  cron: 'Cron',
  webhook: 'Webhook',
  storage: 'Storage',
  workflow: 'Workflow',
};

function AppDetailPage() {
  const app = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const isPinned = Boolean(pins?.some((p) => p.appId === app.id));
  const capabilities = app.capabilities ?? null;
  const hasFrontend = Boolean(capabilities?.frontend);
  const enabledCapabilities = capabilities
    ? (Object.keys(CAPABILITY_LABELS) as (keyof AppCapabilities)[]).filter(
        (key) => capabilities[key],
      )
    : [];

  const isArchived = app.status === 'archived';

  const deploy = useMutation({
    mutationFn: () => deployAppFn({ data: app.id }),
    onSuccess: (result) => {
      toast.success(`Deployed ${app.name} (v${result.version})`);
      void router.invalidate();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveAppFn({ data: { id: app.id, archived } }),
    onSuccess: (_result, archived) => {
      toast.success(archived ? 'App archived' : 'App restored');
      void router.invalidate();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => deleteAppFn({ data: app.id }),
    onSuccess: () => {
      toast.success(`Deleted ${app.name}`);
      void navigate({ to: '/apps' });
    },
    onError: (error) => toast.error((error as Error).message),
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
    onError: (error) => toast.error((error as Error).message),
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
        <Group gap="sm" align="center">
          {app.name}
          <StatusBadge status={app.status} />
        </Group>
      }
      description={app.description || `App · ${app.id}`}
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
          <Button
            variant="default"
            loading={deploy.isPending}
            onClick={() => deploy.mutate()}
            leftSection={<IconRocket size={16} stroke={1.8} />}
          >
            {app.status === 'deployed' ? 'Redeploy' : 'Deploy'}
          </Button>
          {hasFrontend ? (
            <Button
              component="a"
              href={`/app/${app.id}/`}
              target="_blank"
              rel="noreferrer"
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
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          <Card withBorder padding="lg">
            <Text fw={600} mb="sm">
              Overview
            </Text>
            <Stack gap="xs">
              <DetailRow label="Identifier" value={app.id} mono />
              <DetailRow
                label="Backend mode"
                value={app.backendMode ?? 'none'}
              />
              <DetailRow
                label="Database"
                value={app.dbName ?? 'not provisioned'}
                mono={Boolean(app.dbName)}
              />
              <DetailRow
                label="Created"
                value={dayjs(app.createdAt).format('YYYY-MM-DD HH:mm')}
              />
              <DetailRow
                label="Updated"
                value={dayjs(app.updatedAt).format('YYYY-MM-DD HH:mm')}
              />
            </Stack>
          </Card>

          <Card withBorder padding="lg">
            <Text fw={600} mb="sm">
              Capabilities
            </Text>
            {enabledCapabilities.length > 0 ? (
              <Group gap="xs">
                {enabledCapabilities.map((key) => (
                  <Badge key={key} variant="light" radius="sm" color="gray">
                    {CAPABILITY_LABELS[key]}
                  </Badge>
                ))}
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                Capabilities will be detected from the app manifest after its
                first build.
              </Text>
            )}
            <Text size="sm" c="dimmed" mt="lg">
              Continue editing this app from the{' '}
              <Anchor component={Link} to="/agent">
                Agent
              </Anchor>
              .
            </Text>
          </Card>
        </SimpleGrid>

        <CapabilitiesPanel appId={app.id} />

        <DeploymentHistory appId={app.id} />
      </Stack>
    </Page>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Group justify="space-between" gap="md" wrap="nowrap">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ff={mono ? 'monospace' : undefined} truncate>
        {value}
      </Text>
    </Group>
  );
}
