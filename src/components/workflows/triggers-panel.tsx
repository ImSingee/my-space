import {
  ActionIcon,
  Box,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconClock,
  IconCopy,
  IconHandClick,
  IconWebhook,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { toast } from 'sonner';
import { workflowOpsQueryOptions } from '~queries/workflows';

dayjs.extend(relativeTime);

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

export function WorkflowTriggersPanel({ workflowId }: { workflowId: string }) {
  const query = useQuery(workflowOpsQueryOptions(workflowId));
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          Triggers
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Triggers
      </Text>
      <Stack gap="lg">
        <Stack gap={6}>
          <SectionHeader
            icon={<IconHandClick size={16} stroke={1.8} />}
            title="Manual"
          />
          <Text size="xs" c="dimmed">
            Trigger on demand from the workflow&apos;s Run page; inputs are
            validated against its schema before the run starts.
          </Text>
        </Stack>

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
                    <Table.Td w={140}>
                      <Text size="xs" c="dimmed" ff="monospace">
                        {job.schedule}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" truncate>
                        {job.nextRun
                          ? `next ${dayjs(job.nextRun).fromNow()}`
                          : 'not scheduled'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>

        <Stack gap={6}>
          <SectionHeader
            icon={<IconWebhook size={16} stroke={1.8} />}
            title="Inbound webhook"
          />
          {ops.webhook.enabled ? (
            <>
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
                POST a JSON body (or GET with query params) here; the platform
                verifies the secret and starts a run with it as input.
              </Text>
            </>
          ) : (
            <Text size="xs" c="dimmed">
              Webhook trigger is disabled. Enable it in the manifest (
              <Code>triggers.webhook</Code>) and redeploy.
            </Text>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
