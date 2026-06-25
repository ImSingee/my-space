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
import { CapabilitiesPanel } from '~components/subapps/capabilities-panel';
import { DeploymentHistory } from '~components/subapps/deployment-history';
import { StatusBadge } from '~components/subapps/status-badge';
import { sidebarItemsQueryOptions } from '~queries/subapps';
import type { SubappCapabilities } from '~/db/schema';
import {
  archiveSubappFn,
  deleteSubappFn,
  deploySubappFn,
  getSubapp,
  setSidebarPin,
} from '~server/subapps';

export const Route = createFileRoute('/_app/subapps/$subappId')({
  loader: async ({ params }) => {
    const subapp = await getSubapp({ data: params.subappId });
    if (!subapp) {
      throw notFound();
    }
    return subapp;
  },
  component: SubappDetailPage,
});

const CAPABILITY_LABELS: Record<keyof SubappCapabilities, string> = {
  frontend: 'Frontend',
  widgets: 'Widgets',
  backend: 'Backend',
  database: 'Database',
  cron: 'Cron',
  webhook: 'Webhook',
  storage: 'Storage',
  workflow: 'Workflow',
};

function SubappDetailPage() {
  const subapp = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const isPinned = Boolean(pins?.some((p) => p.subappId === subapp.id));
  const capabilities = subapp.capabilities ?? null;
  const enabledCapabilities = capabilities
    ? (Object.keys(CAPABILITY_LABELS) as (keyof SubappCapabilities)[]).filter(
        (key) => capabilities[key],
      )
    : [];

  const isArchived = subapp.status === 'archived';

  const deploy = useMutation({
    mutationFn: () => deploySubappFn({ data: subapp.id }),
    onSuccess: (result) => {
      toast.success(`Deployed ${subapp.name} (v${result.version})`);
      void router.invalidate();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveSubappFn({ data: { id: subapp.id, archived } }),
    onSuccess: (_result, archived) => {
      toast.success(archived ? 'Subapp archived' : 'Subapp restored');
      void router.invalidate();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => deleteSubappFn({ data: subapp.id }),
    onSuccess: () => {
      toast.success(`Deleted ${subapp.name}`);
      void navigate({ to: '/subapps' });
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setSidebarPin({ data: { subappId: subapp.id, pinned } }),
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
      title: `Delete ${subapp.name}?`,
      children: (
        <Text size="sm">
          This permanently removes the subapp, its database, all deployments,
          and dashboard widgets. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete subapp', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
    <Page
      title={
        <Group gap="sm" align="center">
          {subapp.name}
          <StatusBadge status={subapp.status} />
        </Group>
      }
      description={subapp.description || `Subapp · ${subapp.id}`}
      actions={
        <>
          <Button
            component={Link}
            to="/subapps"
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
            {subapp.status === 'deployed' ? 'Redeploy' : 'Deploy'}
          </Button>
          <Button
            component="a"
            href={`/api/subapps/${subapp.id}/app/`}
            target="_blank"
            rel="noreferrer"
            disabled={subapp.status !== 'deployed'}
            leftSection={<IconExternalLink size={16} stroke={1.8} />}
          >
            Open app
          </Button>
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
                Delete subapp
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
              <DetailRow label="Identifier" value={subapp.id} mono />
              <DetailRow
                label="Backend mode"
                value={subapp.backendMode ?? 'none'}
              />
              <DetailRow
                label="Database"
                value={subapp.dbName ?? 'not provisioned'}
                mono={Boolean(subapp.dbName)}
              />
              <DetailRow
                label="Created"
                value={dayjs(subapp.createdAt).format('YYYY-MM-DD HH:mm')}
              />
              <DetailRow
                label="Updated"
                value={dayjs(subapp.updatedAt).format('YYYY-MM-DD HH:mm')}
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
                Capabilities will be detected from the subapp manifest after its
                first build.
              </Text>
            )}
            <Text size="sm" c="dimmed" mt="lg">
              Continue editing this subapp from the{' '}
              <Anchor component={Link} to="/agent">
                Agent
              </Anchor>
              .
            </Text>
          </Card>
        </SimpleGrid>

        <CapabilitiesPanel subappId={subapp.id} />

        <DeploymentHistory subappId={subapp.id} />
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
