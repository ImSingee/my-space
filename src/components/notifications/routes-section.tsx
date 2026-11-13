import {
  ActionIcon,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import { IconArrowRight, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMemo, useState, type FormEvent } from 'react';
import {
  notificationDestinationsQueryOptions,
  notificationGroupsQueryOptions,
  notificationRoutesQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';
import {
  createRouteFn,
  deleteRouteFn,
  updateRouteFn,
  type NotificationSourcesView,
  type RouteView,
} from '~server/notifications';
import { DESTINATION_TYPE_LABEL } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

type SourceType = 'any' | 'app' | 'channel';
const ANY = '__any__';

function kindsFor(
  sources: NotificationSourcesView,
  sourceType: SourceType,
  sourceId: string | null,
) {
  const pool = [
    ...(sourceType !== 'channel' ? sources.apps : []),
    ...(sourceType !== 'app' ? sources.channels : []),
  ].filter((source) => !sourceId || source.id === sourceId);
  const seen = new Map<string, string>();
  for (const source of pool) {
    for (const entry of source.kinds) {
      if (!seen.has(entry.kind)) {
        seen.set(entry.kind, `${entry.name} · ${entry.kind}`);
      }
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}

function useTargets() {
  const { data: groups } = useSuspenseQuery(notificationGroupsQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  return useMemo(() => {
    const options = [
      ...(groups.length
        ? [
            {
              group: 'Groups',
              items: groups.map((group) => ({
                value: `group:${group.id}`,
                label: group.name,
              })),
            },
          ]
        : []),
      ...(destinations.length
        ? [
            {
              group: 'Destinations',
              items: destinations.map((destination) => ({
                value: `destination:${destination.id}`,
                label: `${destination.name} (${DESTINATION_TYPE_LABEL[destination.type]})`,
              })),
            },
          ]
        : []),
    ];
    const label = (route: RouteView) =>
      route.targetType === 'group'
        ? (groups.find((group) => group.id === route.targetId)?.name ??
          'Removed group')
        : (destinations.find((d) => d.id === route.targetId)?.name ??
          'Removed destination');
    return { options, label };
  }, [groups, destinations]);
}

function RouteModal({ onClose }: { onClose: () => void }) {
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const targets = useTargets();
  const [name, setName] = useState('');
  const [sourceType, setSourceType] = useState<SourceType>('any');
  const [sourceId, setSourceId] = useState<string>(ANY);
  const [kind, setKind] = useState<string>(ANY);
  const [target, setTarget] = useState<string | null>(null);

  const create = useNotificationMutation(
    (input: Parameters<typeof createRouteFn>[0]['data']) =>
      createRouteFn({ data: input }),
    { success: 'Route created', onSuccess: () => onClose() },
  );

  const sourceOptions = [
    {
      value: ANY,
      label: sourceType === 'app' ? 'Any App' : 'Any Channel',
    },
    ...(sourceType === 'app' ? sources.apps : sources.channels).map(
      (source) => ({ value: source.id, label: source.name }),
    ),
  ];
  const kindOptions = [
    { value: ANY, label: 'Any kind' },
    ...kindsFor(sources, sourceType, sourceId === ANY ? null : sourceId),
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    const [targetType, targetId] = target.split(':') as [
      'group' | 'destination',
      string,
    ];
    create.mutate({
      name: name.trim() || null,
      sourceType,
      sourceId: sourceType === 'any' || sourceId === ANY ? null : sourceId,
      kind: kind === ANY ? null : kind,
      targetType,
      targetId,
    });
  };

  return (
    <Modal opened onClose={onClose} title="New route" centered>
      <form onSubmit={submit}>
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              When a notification comes from
            </Text>
            <SegmentedControl
              value={sourceType}
              onChange={(value) => {
                setSourceType(value as SourceType);
                setSourceId(ANY);
                setKind(ANY);
              }}
              data={[
                { value: 'any', label: 'Anywhere' },
                { value: 'app', label: 'An App' },
                { value: 'channel', label: 'A Channel' },
              ]}
            />
          </Stack>
          {sourceType !== 'any' ? (
            <Select
              label={sourceType === 'app' ? 'App' : 'Channel'}
              data={sourceOptions}
              value={sourceId}
              onChange={(value) => {
                setSourceId(value ?? ANY);
                setKind(ANY);
              }}
              allowDeselect={false}
              searchable
            />
          ) : null}
          <Select
            label="Kind"
            data={kindOptions}
            value={kind}
            onChange={(value) => setKind(value ?? ANY)}
            allowDeselect={false}
            searchable
          />
          <Select
            label="Deliver to"
            placeholder="Choose a group or destination"
            data={targets.options}
            value={target}
            onChange={setTarget}
            required
            searchable
            nothingFoundMessage="Add a destination first"
          />
          <TextInput
            label="Name"
            description="Optional, shown in the route list."
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!target}>
              Create route
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function RoutesSection() {
  const { data: routes } = useSuspenseQuery(notificationRoutesQueryOptions);
  const { data: sources } = useSuspenseQuery(notificationSourcesQueryOptions);
  const targets = useTargets();
  const [creating, setCreating] = useState(false);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) => updateRouteFn({ data: input }),
  );
  const remove = useNotificationMutation(
    (id: string) => deleteRouteFn({ data: id }),
    { success: 'Route deleted' },
  );

  const sourceLabel = (route: RouteView) => {
    if (route.sourceType === 'any') return 'Any source';
    if (!route.sourceId) {
      return route.sourceType === 'app' ? 'Any App' : 'Any Channel';
    }
    const list = route.sourceType === 'app' ? sources.apps : sources.channels;
    return (
      list.find((source) => source.id === route.sourceId)?.name ??
      (route.sourceType === 'app' ? 'Unavailable App' : 'Removed Channel')
    );
  };
  const kindLabel = (route: RouteView) => {
    if (!route.kind) return 'any kind';
    const match = kindsFor(sources, route.sourceType, route.sourceId).find(
      (entry) => entry.value === route.kind,
    );
    return match?.label ?? route.kind;
  };

  const confirmDelete = (route: RouteView) =>
    modals.openConfirmModal({
      title: 'Delete this route?',
      centered: true,
      children: (
        <Text size="sm">
          Matching notifications stop being delivered to {targets.label(route)}.
        </Text>
      ),
      labels: { confirm: 'Delete route', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(route.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title="Routes"
        description="Decide which notifications go where. A notification matching several routes is delivered once per destination."
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreating(true)}
          >
            New route
          </Button>
        }
      />

      {routes.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No routes yet, so notifications are recorded but not delivered.
        </Text>
      ) : (
        <Table verticalSpacing="sm" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Match</Table.Th>
              <Table.Th w="30%">Deliver to</Table.Th>
              <Table.Th w={90}>Enabled</Table.Th>
              <Table.Th w={48} aria-label="Actions" />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {routes.map((route) => (
              <Table.Tr key={route.id}>
                <Table.Td>
                  <Stack gap={0} miw={0}>
                    <Text size="sm" fw={500} truncate>
                      {sourceLabel(route)} · {kindLabel(route)}
                    </Text>
                    {route.name ? (
                      <Text size="xs" c="dimmed" truncate>
                        {route.name}
                      </Text>
                    ) : null}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <IconArrowRight
                      size={14}
                      stroke={1.6}
                      color="var(--mantine-color-dimmed)"
                    />
                    <Text size="sm" truncate>
                      {targets.label(route)}
                    </Text>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={
                      toggle.isPending && toggle.variables?.id === route.id
                        ? toggle.variables.enabled
                        : route.enabled
                    }
                    onChange={(event) =>
                      toggle.mutate({
                        id: route.id,
                        enabled: event.currentTarget.checked,
                      })
                    }
                    aria-label="Enable route"
                  />
                </Table.Td>
                <Table.Td>
                  <Tooltip label="Delete route" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label="Delete route"
                      onClick={() => confirmDelete(route)}
                    >
                      <IconTrash size={16} stroke={1.6} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {creating ? <RouteModal onClose={() => setCreating(false)} /> : null}
    </Stack>
  );
}
