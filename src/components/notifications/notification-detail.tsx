import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconRefresh } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Field } from '~components/system/field';
import { formatExact, formatRelative } from '~lib/format';
import {
  NOTIFICATIONS_KEY,
  notificationDetailQueryOptions,
} from '~queries/notifications';
import { retryDeliveryFn, type DeliveryView } from '~server/notifications';
import {
  DESTINATION_TYPE_LABEL,
  DeliveryStatusBadge,
  DestinationTypeIcon,
  NotificationStatusBadge,
} from './status';

const SOURCE_TYPE_LABEL = { app: 'App', channel: 'Channel' } as const;

export function NotificationDetail({ id }: { id: string }) {
  const { data } = useSuspenseQuery(notificationDetailQueryOptions(id));

  return (
    <Stack gap="xl">
      <Box component="section">
        <Group gap="sm" mb="md" wrap="wrap">
          <NotificationStatusBadge status={data.status} />
          <Text size="sm" c="dimmed">
            {data.deliveries.succeeded} delivered · {data.deliveries.pending} in
            progress · {data.deliveries.failed} failed
          </Text>
        </Group>
        <Stack gap={8}>
          <Field
            label="Source"
            value={
              data.sourceType === 'platform'
                ? `${data.sourceName} (test)`
                : `${SOURCE_TYPE_LABEL[data.sourceType]} · ${data.sourceName}`
            }
          />
          <Field label="Kind" value={`${data.kindName} (${data.kind})`} />
          <Field label="Occurred" value={formatExact(data.occurredAt)} />
          <Field label="Received" value={formatExact(data.createdAt)} />
          {data.dedupeKey ? (
            <Field label="Dedupe key" value={data.dedupeKey} mono />
          ) : null}
          <Field label="ID" value={data.id} mono copyValue={data.id} />
          {data.url ? (
            <Group gap="md" wrap="nowrap" align="baseline">
              <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
                Link
              </Text>
              <Anchor
                href={data.url}
                target="_blank"
                rel="noreferrer"
                size="sm"
                truncate
              >
                {data.url}
              </Anchor>
              {data.autoOpenUrl ? (
                <Tooltip label="Tapping the phone notification opens this link instead of the notification.">
                  <Badge variant="light" color="gray" style={{ flex: 'none' }}>
                    Opens on tap
                  </Badge>
                </Tooltip>
              ) : null}
            </Group>
          ) : null}
        </Stack>
        {data.body ? (
          <Text size="sm" mt="lg" style={{ whiteSpace: 'pre-wrap' }}>
            {data.body}
          </Text>
        ) : null}
        {data.data ? (
          <Stack gap={6} mt="lg">
            <Text size="sm" fw={600}>
              Data
            </Text>
            <Code block style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
              {JSON.stringify(data.data, null, 2)}
            </Code>
          </Stack>
        ) : null}
      </Box>

      <Divider />

      <Box component="section">
        <Text fw={600} fz="lg" mb="xs">
          Deliveries
        </Text>
        {data.deliveryList.length === 0 ? (
          <Text size="sm" c="dimmed">
            No route matched this notification, so it was recorded without being
            delivered. Add a route in Settings → Notifications.
          </Text>
        ) : (
          <Table verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Destination</Table.Th>
                <Table.Th w={130}>Status</Table.Th>
                <Table.Th w={80}>Attempts</Table.Th>
                <Table.Th>Outcome</Table.Th>
                <Table.Th w={110} aria-label="Actions" />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.deliveryList.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  notificationId={id}
                  delivery={delivery}
                />
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Box>
    </Stack>
  );
}

function DeliveryRow({
  notificationId,
  delivery,
}: {
  notificationId: string;
  delivery: DeliveryView;
}) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryDeliveryFn({ data: delivery.id }),
    onSuccess: () => toast.success('Delivery queued again'),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(
          notificationDetailQueryOptions(notificationId),
        ),
        queryClient.invalidateQueries({
          queryKey: [...NOTIFICATIONS_KEY, 'history'],
        }),
      ]),
  });

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          <Box c="dimmed" style={{ display: 'inline-flex' }}>
            <DestinationTypeIcon type={delivery.destinationType} />
          </Box>
          <Stack gap={0} miw={0}>
            <Text size="sm" fw={500} truncate>
              {delivery.destinationName}
            </Text>
            <Text size="xs" c="dimmed">
              {DESTINATION_TYPE_LABEL[delivery.destinationType]}
              {delivery.destinationId ? '' : ' · removed'}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <DeliveryStatusBadge status={delivery.status} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {delivery.attempts}
        </Text>
      </Table.Td>
      <Table.Td>
        <DeliveryOutcome delivery={delivery} />
      </Table.Td>
      <Table.Td>
        {delivery.status === 'failed' && delivery.destinationId ? (
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} stroke={1.8} />}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry
          </Button>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

function DeliveryOutcome({ delivery }: { delivery: DeliveryView }) {
  const lines: { label: string; value: string; mono?: boolean }[] = [];
  if (delivery.result) {
    lines.push({ label: 'App result', value: delivery.result });
  }
  if (delivery.lastError) {
    lines.push({ label: 'Error', value: delivery.lastError });
  }
  if (delivery.httpStatus !== null) {
    lines.push({
      label: 'HTTP',
      value: String(delivery.httpStatus),
      mono: true,
    });
  }
  const when =
    delivery.nextAttemptAt && delivery.status === 'pending' && delivery.attempts
      ? `Next attempt ${formatRelative(delivery.nextAttemptAt)}`
      : delivery.completedAt
        ? formatRelative(delivery.completedAt)
        : null;

  if (lines.length === 0 && !when) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {lines.map((line) => (
        <Text
          key={line.label}
          size="xs"
          c={line.label === 'Error' ? 'red.8' : undefined}
          ff={line.mono ? 'monospace' : undefined}
          style={{ wordBreak: 'break-word' }}
        >
          <Text span size="xs" c="dimmed">
            {line.label}:{' '}
          </Text>
          {line.value}
        </Text>
      ))}
      {when ? (
        <Tooltip
          label={formatExact(delivery.nextAttemptAt ?? delivery.completedAt)}
          withArrow
        >
          <Text size="xs" c="dimmed" w="fit-content">
            {when}
          </Text>
        </Tooltip>
      ) : null}
    </Stack>
  );
}
