import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import {
  notificationDestinationsQueryOptions,
  notificationGroupsQueryOptions,
} from '~queries/notifications';
import {
  createGroupFn,
  deleteGroupFn,
  updateGroupFn,
  type GroupView,
} from '~server/notifications';
import { DESTINATION_TYPE_LABEL } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

function GroupModal({
  editing,
  onClose,
}: {
  editing: GroupView | null;
  onClose: () => void;
}) {
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [members, setMembers] = useState<string[]>(
    editing?.destinationIds ?? [],
  );

  const save = useNotificationMutation(
    (input: {
      name: string;
      description: string | null;
      destinationIds: string[];
    }) =>
      editing
        ? updateGroupFn({ data: { id: editing.id, ...input } })
        : createGroupFn({ data: input }),
    {
      success: editing ? 'Group updated' : 'Group created',
      onSuccess: () => onClose(),
    },
  );

  const options = (['device', 'webhook', 'app'] as const)
    .map((type) => ({
      group: `${DESTINATION_TYPE_LABEL[type]}s`,
      items: destinations
        .filter((destination) => destination.type === type)
        .map((destination) => ({
          value: destination.id,
          label: destination.name,
        })),
    }))
    .filter((group) => group.items.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      name,
      description: description.trim() || null,
      destinationIds: members,
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={editing ? 'Edit group' : 'New group'}
      centered
    >
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="My phones"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            maxLength={80}
            data-autofocus
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            maxLength={500}
          />
          <MultiSelect
            label="Destinations"
            placeholder={members.length ? undefined : 'Choose destinations'}
            data={options}
            value={members}
            onChange={setMembers}
            searchable
            nothingFoundMessage="No destinations"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {editing ? 'Save' : 'Create group'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function GroupsSection() {
  const { data: groups } = useSuspenseQuery(notificationGroupsQueryOptions);
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [modal, setModal] = useState<{ editing: GroupView | null } | null>(
    null,
  );
  const remove = useNotificationMutation(
    (id: string) => deleteGroupFn({ data: id }),
    { success: 'Group deleted' },
  );
  const nameOf = new Map(destinations.map((d) => [d.id, d.name]));

  const confirmDelete = (group: GroupView) =>
    modals.openConfirmModal({
      title: `Delete ${group.name}?`,
      centered: true,
      children: (
        <Text size="sm">
          Routes that deliver to this group are deleted too. The destinations
          themselves stay.
        </Text>
      ),
      labels: { confirm: 'Delete group', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(group.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title="Groups"
        description="Bundle destinations so one route can reach all of them."
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setModal({ editing: null })}
          >
            New group
          </Button>
        }
      />

      {groups.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No groups yet.
        </Text>
      ) : (
        <Table verticalSpacing="sm" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="32%">Group</Table.Th>
              <Table.Th>Destinations</Table.Th>
              <Table.Th w={84} aria-label="Actions" />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {groups.map((group) => (
              <Table.Tr key={group.id}>
                <Table.Td>
                  <Text size="sm" fw={600} truncate>
                    {group.name}
                  </Text>
                  {group.description ? (
                    <Text size="xs" c="dimmed" truncate>
                      {group.description}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  {group.destinationIds.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      Empty
                    </Text>
                  ) : (
                    <Group gap={6}>
                      {group.destinationIds.map((id) => (
                        <Badge
                          key={id}
                          variant="light"
                          color="gray"
                          radius="sm"
                        >
                          {nameOf.get(id) ?? 'Removed'}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Edit group" withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Edit ${group.name}`}
                        onClick={() => setModal({ editing: group })}
                      >
                        <IconPencil size={16} stroke={1.6} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete group" withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Delete ${group.name}`}
                        onClick={() => confirmDelete(group)}
                      >
                        <IconTrash size={16} stroke={1.6} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {modal ? (
        <GroupModal
          key={modal.editing?.id ?? 'new'}
          editing={modal.editing}
          onClose={() => setModal(null)}
        />
      ) : null}
    </Stack>
  );
}
