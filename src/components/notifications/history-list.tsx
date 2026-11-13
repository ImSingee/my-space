import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { IconBell } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { formatExact, formatRelative } from '~lib/format';
import {
  notificationHistoryQueryOptions,
  notificationSourcesQueryOptions,
  type NotificationFilters,
} from '~queries/notifications';
import type { NotificationStatus } from '~server/notifications';
import {
  NOTIFICATION_STATUS_OPTIONS,
  NotificationStatusBadge,
  SourceTypeIcon,
} from './status';

function parseSource(
  value: string | null,
): Pick<NotificationFilters, 'sourceType' | 'sourceId'> {
  if (!value) return {};
  if (value === 'platform') return { sourceType: 'platform' };
  const [type, id] = value.split(':');
  return {
    sourceType: type === 'app' ? 'app' : 'channel',
    sourceId: id,
  };
}

export function NotificationHistory() {
  const navigate = useNavigate();
  const [source, setSource] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const { data: sources } = useQuery(notificationSourcesQueryOptions);

  const filters: NotificationFilters = {
    ...parseSource(source),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  };
  const history = useInfiniteQuery(notificationHistoryQueryOptions(filters));

  const sourceOptions = useMemo(
    () => [
      ...(sources?.apps.length
        ? [
            {
              group: 'Apps',
              items: sources.apps.map((app) => ({
                value: `app:${app.id}`,
                label: app.name,
              })),
            },
          ]
        : []),
      ...(sources?.channels.length
        ? [
            {
              group: 'Channels',
              items: sources.channels.map((channel) => ({
                value: `channel:${channel.id}`,
                label: channel.name,
              })),
            },
          ]
        : []),
      {
        group: 'Hatch',
        items: [{ value: 'platform', label: 'Test notifications' }],
      },
    ],
    [sources],
  );

  const kindOptions = useMemo(() => {
    const selected = parseSource(source);
    const all = [
      ...(sources?.apps ?? []).map((app) => ({ id: app.id, kinds: app.kinds })),
      ...(sources?.channels ?? []).map((channel) => ({
        id: channel.id,
        kinds: channel.kinds,
      })),
    ].filter((entry) => !selected.sourceId || entry.id === selected.sourceId);
    const seen = new Map<string, string>();
    for (const entry of all) {
      for (const k of entry.kinds) {
        if (!seen.has(k.kind)) seen.set(k.kind, `${k.name} · ${k.kind}`);
      }
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [source, sources]);

  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(source || kind || status);

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <Select
          placeholder="All sources"
          aria-label="Filter by source"
          data={sourceOptions}
          value={source}
          onChange={(value) => {
            setSource(value);
            setKind(null);
          }}
          clearable
          searchable
          w={220}
        />
        <Select
          placeholder="All kinds"
          aria-label="Filter by kind"
          data={kindOptions}
          value={kind}
          onChange={setKind}
          clearable
          searchable
          disabled={kindOptions.length === 0}
          w={240}
        />
        <Select
          placeholder="Any status"
          aria-label="Filter by delivery status"
          data={NOTIFICATION_STATUS_OPTIONS}
          value={status}
          onChange={(value) => setStatus(value as NotificationStatus | null)}
          clearable
          w={180}
        />
      </Group>

      {history.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Stack align="center" gap="xs" py={80} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="ember">
            <IconBell size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={600} mt="xs">
            {filtered ? 'No matching notifications' : 'No notifications yet'}
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={480}>
            {filtered
              ? 'Try clearing a filter.'
              : 'Notifications pushed by Apps and Channels show up here, with where each one was delivered.'}
          </Text>
          {!filtered ? (
            <Button
              component={Link}
              to="/settings/notifications"
              variant="default"
              mt="sm"
            >
              Set up delivery
            </Button>
          ) : null}
        </Stack>
      ) : (
        <Box component="section">
          <Table highlightOnHover verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Notification</Table.Th>
                <Table.Th w={200}>Source</Table.Th>
                <Table.Th w={150}>Status</Table.Th>
                <Table.Th w={140}>Received</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((item) => (
                <Table.Tr
                  key={item.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    navigate({
                      to: '/notifications/$notificationId',
                      params: { notificationId: item.id },
                    })
                  }
                >
                  <Table.Td>
                    <Stack
                      gap={2}
                      miw={0}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/notifications/$notificationId"
                          params={{ notificationId: item.id }}
                          onClick={(event) => event.stopPropagation()}
                        />
                      )}
                    >
                      <Text size="sm" fw={500} truncate>
                        {item.title}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {item.kindName}
                        {item.body ? ` · ${item.body}` : ''}
                      </Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap" c="dimmed">
                      <SourceTypeIcon type={item.sourceType} size={15} />
                      <Text size="sm" c="dimmed" truncate>
                        {item.sourceName}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <NotificationStatusBadge status={item.status} />
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={formatExact(item.createdAt)} withArrow>
                      <Text size="sm" c="dimmed" w="fit-content">
                        {formatRelative(item.createdAt)}
                      </Text>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {history.hasNextPage ? (
            <Center mt="md">
              <Button
                variant="default"
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Load more
              </Button>
            </Center>
          ) : null}
        </Box>
      )}
    </Stack>
  );
}
