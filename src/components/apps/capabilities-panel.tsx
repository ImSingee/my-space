import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconBolt,
  IconClock,
  IconCopy,
  IconDatabaseCog,
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

function SectionHeader({
  icon,
  title,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text fw={600} size="sm">
          {title}
        </Text>
      </Group>
      {right}
    </Group>
  );
}

export function CapabilitiesPanel({ appId }: { appId: string }) {
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

  if (query.isLoading) {
    return (
      <Card withBorder padding="lg">
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Card>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  const anyEnabled =
    ops.backend.capable ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.storage.enabled;

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Card withBorder padding="lg">
      <Group gap="xs" mb="md">
        <IconBolt size={18} stroke={1.8} />
        <Text fw={600}>Capabilities</Text>
      </Group>

      {!anyEnabled ? (
        <Text size="sm" c="dimmed">
          No extended capabilities are enabled for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconServerBolt size={16} stroke={1.8} />}
                title="Backend"
                right={
                  <Group gap={6}>
                    <Badge size="sm" variant="light" radius="sm" color="gray">
                      {ops.backend.mode ?? 'serverless'}
                    </Badge>
                    <Badge
                      size="sm"
                      variant="dot"
                      radius="sm"
                      color={ops.backend.running ? 'teal' : 'gray'}
                    >
                      {ops.backend.running ? 'running' : 'idle'}
                    </Badge>
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
                <Stack gap={6}>
                  {ops.cron.jobs.map((job) => (
                    <Group
                      key={job.name}
                      justify="space-between"
                      wrap="nowrap"
                      gap="sm"
                    >
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Text size="sm" fw={500}>
                          {job.name}
                        </Text>
                        <Code>{job.schedule}</Code>
                        <Text size="xs" c="dimmed" truncate>
                          {job.path}
                          {job.nextRun
                            ? ` · next ${dayjs(job.nextRun).fromNow()}`
                            : ''}
                        </Text>
                      </Group>
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<IconPlayerPlay size={14} />}
                        loading={
                          runCron.isPending && runCron.variables === job.name
                        }
                        onClick={() => runCron.mutate(job.name)}
                      >
                        Run now
                      </Button>
                    </Group>
                  ))}
                </Stack>
              )}
            </Stack>
          ) : null}

          {ops.webhook.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconWebhook size={16} stroke={1.8} />}
                title="Inbound webhook"
                right={
                  <Tooltip label="Copy URL with secret" withArrow>
                    <ActionIcon
                      variant="light"
                      aria-label="Copy webhook URL"
                      onClick={() => {
                        const url = `${origin}${ops.webhook.url ?? ''}?secret=${
                          ops.webhook.secret ?? ''
                        }`;
                        copy(url);
                        toast.success('Webhook URL copied');
                      }}
                    >
                      <IconCopy size={16} />
                    </ActionIcon>
                  </Tooltip>
                }
              />
              <Code block style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
                {`${ops.webhook.url ?? ''}?secret=${ops.webhook.secret ?? ''}`}
              </Code>
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
                right={
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
                <Table verticalSpacing={6} highlightOnHover>
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
                        <Table.Td w={40}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={`Delete ${obj.key}`}
                            loading={
                              deleteObject.isPending &&
                              deleteObject.variables === obj.key
                            }
                            onClick={() => deleteObject.mutate(obj.key)}
                          >
                            <IconTrash size={15} />
                          </ActionIcon>
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
    </Card>
  );
}
