import {
  ActionIcon,
  Box,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconClock,
  IconCopy,
  IconDatabase,
  IconDatabaseCog,
  IconDownload,
  IconPlayerPlay,
  IconServerBolt,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { toast } from 'sonner';
import { appOpsQueryOptions } from '~queries/apps';
import { deleteStorageObjectFn, runCronJobFn } from '~server/apps';

dayjs.extend(relativeTime);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Flat section header: the title's status / value flows inline right after the
// label (as `meta`) instead of being pinned to the far right — there is no card
// frame to anchor a right edge against anymore.
function SectionHeader({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
}) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <Text fw={600} size="sm">
        {title}
      </Text>
      {meta}
    </Group>
  );
}

// A small, flat status indicator (not a pill badge): ember when active, muted
// otherwise.
function StatusDot({ active }: { active: boolean }) {
  return (
    <Box
      aria-hidden
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        backgroundColor: active
          ? 'var(--mantine-color-ember-6)'
          : 'var(--mantine-color-gray-4)',
      }}
    />
  );
}

export function OperationsPanel({
  appId,
  dbName,
  dbEnabled,
}: {
  appId: string;
  /** Provisioned database name, or null when not yet provisioned. */
  dbName?: string | null;
  /** Whether this app declares/uses a database (controls the Database row). */
  dbEnabled?: boolean;
}) {
  const qc = useQueryClient();
  const query = useQuery(appOpsQueryOptions(appId));

  const runCron = useMutation({
    mutationFn: (name: string) => runCronJobFn({ data: { id: appId, name } }),
    onSuccess: (res, name) => {
      if (res.status >= 200 && res.status < 300) {
        toast.success(`Ran "${name}" (${res.status})`);
      } else {
        toast.error(`"${name}" returned ${res.status}`);
      }
      void qc.invalidateQueries(appOpsQueryOptions(appId));
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const deleteObject = useMutation({
    mutationFn: (key: string) =>
      deleteStorageObjectFn({ data: { id: appId, key } }),
    onSuccess: () => {
      toast.success('Deleted object');
      void qc.invalidateQueries(appOpsQueryOptions(appId));
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const confirmDeleteObject = (key: string) =>
    modals.openConfirmModal({
      title: 'Delete object?',
      children: (
        <Text size="sm">
          Permanently delete{' '}
          <Text span fw={600} ff="monospace">
            {key}
          </Text>{' '}
          from this app&apos;s storage? This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteObject.mutate(key),
    });

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          Operations
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  const anyEnabled =
    ops.backend.capable ||
    Boolean(dbEnabled) ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.storage.enabled;

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Operations
      </Text>

      {!anyEnabled ? (
        <Text size="sm" c="dimmed">
          No database, backend, scheduled jobs, webhook, or storage to manage
          for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconServerBolt size={16} stroke={1.8} />}
                title="Backend"
                meta={
                  <Group gap={6} wrap="nowrap">
                    <StatusDot active={ops.backend.running} />
                    <Text size="xs" c="dimmed">
                      {ops.backend.running ? 'Running' : 'Idle'} ·{' '}
                      {ops.backend.mode ?? 'serverless'}
                    </Text>
                  </Group>
                }
              />
              <Text size="xs" c="dimmed">
                {ops.backend.mode === 'long-running'
                  ? 'Kept warm by the platform and restarted automatically if it exits.'
                  : 'Booted on demand for each request, then idles down.'}
              </Text>
            </Stack>
          ) : null}

          {dbEnabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconDatabase size={16} stroke={1.8} />}
                title="Database"
                meta={
                  dbName ? (
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {dbName}
                    </Text>
                  ) : (
                    <Text size="xs" c="dimmed">
                      not provisioned
                    </Text>
                  )
                }
              />
              <Text size="xs" c="dimmed">
                {dbName
                  ? 'A dedicated Postgres database for this app.'
                  : 'A Postgres database is provisioned automatically on first use.'}
              </Text>
            </Stack>
          ) : null}

          {ops.cron.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconClock size={16} stroke={1.8} />}
                title="Scheduled jobs"
              />
              {ops.cron.jobs.length === 0 ? (
                <Text size="xs" c="dimmed">
                  No cron jobs declared in the manifest.
                </Text>
              ) : (
                <Table withTableBorder verticalSpacing={6} highlightOnHover>
                  <Table.Tbody>
                    {ops.cron.jobs.map((job) => (
                      <Table.Tr key={job.name}>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {job.name}
                          </Text>
                        </Table.Td>
                        <Table.Td w={120}>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {job.schedule}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed" truncate>
                            {job.path}
                            {job.nextRun
                              ? ` · next ${dayjs(job.nextRun).fromNow()}`
                              : ''}
                          </Text>
                        </Table.Td>
                        <Table.Td w={110}>
                          <Button
                            size="compact-sm"
                            variant="light"
                            leftSection={<IconPlayerPlay size={14} />}
                            loading={
                              runCron.isPending &&
                              runCron.variables === job.name
                            }
                            onClick={() => runCron.mutate(job.name)}
                          >
                            Run now
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          ) : null}

          {ops.webhook.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconWebhook size={16} stroke={1.8} />}
                title="Inbound webhook"
              />
              <Group gap={8} wrap="nowrap" align="center">
                <Code
                  block
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 'var(--mantine-font-size-xs)',
                  }}
                >
                  {`${ops.webhook.url ?? ''}?secret=${ops.webhook.secret ?? ''}`}
                </Code>
                <Tooltip label="Copy URL with secret" withArrow position="left">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Copy webhook URL"
                    onClick={() => {
                      const url = `${origin}${ops.webhook.url ?? ''}?secret=${
                        ops.webhook.secret ?? ''
                      }`;
                      copy(url);
                      toast.success('Webhook URL copied');
                    }}
                  >
                    <IconCopy size={15} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Text size="xs" c="dimmed">
                POST here from external services. The platform verifies the
                secret and forwards to your backend at <Code>/__webhook</Code>.
              </Text>
            </Stack>
          ) : null}

          {ops.storage.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconDatabaseCog size={16} stroke={1.8} />}
                title="Storage"
                meta={
                  <Text size="xs" c="dimmed">
                    {ops.storage.objects.length} object
                    {ops.storage.objects.length === 1 ? '' : 's'}
                  </Text>
                }
              />
              {ops.storage.objects.length === 0 ? (
                <Text size="xs" c="dimmed">
                  No objects stored yet.
                </Text>
              ) : (
                <Table withTableBorder verticalSpacing={6} highlightOnHover>
                  <Table.Tbody>
                    {ops.storage.objects.map((obj) => (
                      <Table.Tr key={obj.key}>
                        <Table.Td>
                          <Text size="sm" truncate>
                            {obj.key}
                          </Text>
                        </Table.Td>
                        <Table.Td w={90}>
                          <Text size="xs" c="dimmed">
                            {formatBytes(obj.size)}
                          </Text>
                        </Table.Td>
                        <Table.Td w={120}>
                          <Text size="xs" c="dimmed" truncate>
                            {dayjs(obj.updatedAt).fromNow()}
                          </Text>
                        </Table.Td>
                        <Table.Td w={76}>
                          <Group gap={2} justify="flex-end" wrap="nowrap">
                            <Tooltip label="Download" withArrow position="top">
                              <ActionIcon
                                component="a"
                                href={`/api/apps/${appId}/storage/${encodeURIComponent(
                                  obj.key,
                                )}`}
                                download
                                variant="subtle"
                                color="gray"
                                aria-label={`Download ${obj.key}`}
                              >
                                <IconDownload size={15} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="Delete" withArrow position="top">
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                aria-label={`Delete ${obj.key}`}
                                loading={
                                  deleteObject.isPending &&
                                  deleteObject.variables === obj.key
                                }
                                onClick={() => confirmDeleteObject(obj.key)}
                              >
                                <IconTrash size={15} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          ) : null}
        </Stack>
      )}
    </Box>
  );
}
