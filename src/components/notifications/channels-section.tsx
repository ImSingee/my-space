import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSuspenseQuery } from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconCode,
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { notificationChannelsQueryOptions } from '~queries/notifications';
import {
  createChannelFn,
  deleteChannelFn,
  rotateChannelTokenFn,
  updateChannelFn,
  type ChannelView,
} from '~server/notifications';
import {
  EMPTY_KIND,
  KindsEditor,
  kindsError,
  toKindInput,
  type KindDraft,
} from './kinds-editor';
import { CopyableCode, SecretReveal } from './secret-reveal';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

function curlExample(channel: ChannelView, token: string): string {
  const kind = channel.kinds[0]?.kind ?? 'example';
  return [
    `curl -X POST '${channel.pushUrl}' \\`,
    `  -H 'x-hatch-secret: ${token}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ kind, title: 'Hello from outside' })}'`,
  ].join('\n');
}

function PushInstructions({
  channel,
  token,
}: {
  channel: ChannelView;
  token: string | null;
}) {
  return (
    <Stack gap="sm">
      {token ? <SecretReveal label="Channel token" secret={token} /> : null}
      <CopyableCode label="Push URL" value={channel.pushUrl} />
      <CopyableCode
        label="Example"
        value={curlExample(channel, token ?? '<channel token>')}
      />
      <Text size="xs" c="dimmed">
        Body fields: <code>kind</code> and <code>title</code> are required;{' '}
        <code>body</code>, <code>url</code>, <code>data</code> (JSON object),{' '}
        <code>dedupeKey</code> and <code>occurredAt</code> are optional. The
        token can also be passed as <code>?secret=</code>.
      </Text>
    </Stack>
  );
}

function ChannelModal({
  editing,
  onClose,
}: {
  editing: ChannelView | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [kinds, setKinds] = useState<KindDraft[]>(
    editing
      ? editing.kinds.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          description: entry.description ?? '',
        }))
      : [EMPTY_KIND],
  );
  const [created, setCreated] = useState<{
    channel: ChannelView;
    token: string;
  } | null>(null);
  const invalid = kindsError(kinds);

  const save = useNotificationMutation(
    async (input: {
      name: string;
      description: string | null;
      kinds: ReturnType<typeof toKindInput>;
    }) => {
      if (editing) {
        await updateChannelFn({ data: { id: editing.id, ...input } });
        return null;
      }
      return createChannelFn({ data: input });
    },
    {
      success: editing ? 'Channel updated' : 'Channel created',
      onSuccess: (result) => {
        if (result) setCreated(result);
        else onClose();
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    save.mutate({
      name,
      description: description.trim() || null,
      kinds: toKindInput(kinds),
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      centered
      closeOnClickOutside={!created}
      title={
        created ? 'Channel created' : editing ? 'Edit channel' : 'New channel'
      }
    >
      {created ? (
        <Stack gap="md">
          <PushInstructions channel={created.channel} token={created.token} />
          <Group justify="flex-end">
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <TextInput
              label="Name"
              placeholder="Home server"
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
            <KindsEditor value={kinds} onChange={setKinds} />
            {invalid && kinds.some((entry) => entry.kind || entry.name) ? (
              <Text size="xs" c="red.8">
                {invalid}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={save.isPending}
                disabled={Boolean(invalid)}
              >
                {editing ? 'Save' : 'Create channel'}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function InstructionsModal({
  state,
  onClose,
}: {
  state: { channel: ChannelView; token: string | null } | null;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={state !== null}
      onClose={onClose}
      size="lg"
      centered
      closeOnClickOutside={!state?.token}
      title={state?.token ? 'New channel token' : 'Push to this channel'}
    >
      {state ? (
        <Stack gap="md">
          {state.token ? (
            <Alert
              color="gray"
              variant="light"
              icon={<IconAlertCircle size={18} stroke={1.6} />}
            >
              The previous token stopped working. Update every sender.
            </Alert>
          ) : null}
          <PushInstructions channel={state.channel} token={state.token} />
          <Group justify="flex-end">
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

export function ChannelsSection() {
  const { data: channels } = useSuspenseQuery(notificationChannelsQueryOptions);
  const [modal, setModal] = useState<{ editing: ChannelView | null } | null>(
    null,
  );
  const [instructions, setInstructions] = useState<{
    channel: ChannelView;
    token: string | null;
  } | null>(null);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) =>
      updateChannelFn({ data: input }),
  );
  const rotate = useNotificationMutation(
    (channel: ChannelView) =>
      rotateChannelTokenFn({ data: channel.id }).then((result) => ({
        channel,
        token: result.token,
      })),
    { onSuccess: (result) => setInstructions(result) },
  );
  const remove = useNotificationMutation(
    (id: string) => deleteChannelFn({ data: id }),
    { success: 'Channel deleted' },
  );

  const confirmRotate = (channel: ChannelView) =>
    modals.openConfirmModal({
      title: `Rotate the token of ${channel.name}?`,
      centered: true,
      children: (
        <Text size="sm">The current token stops working immediately.</Text>
      ),
      labels: { confirm: 'Rotate token', cancel: 'Cancel' },
      onConfirm: () => rotate.mutate(channel),
    });
  const confirmDelete = (channel: ChannelView) =>
    modals.openConfirmModal({
      title: `Delete ${channel.name}?`,
      centered: true,
      children: (
        <Text size="sm">
          Senders can no longer push to it and its routes are deleted. Past
          notifications stay in the history.
        </Text>
      ),
      labels: { confirm: 'Delete channel', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(channel.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title="Channels"
        description="Let outside services push notifications into Hatch, like an App would."
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setModal({ editing: null })}
          >
            New channel
          </Button>
        }
      />

      {channels.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No channels yet.
        </Text>
      ) : (
        <Table verticalSpacing="sm" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="32%">Channel</Table.Th>
              <Table.Th>Kinds</Table.Th>
              <Table.Th w={90}>Enabled</Table.Th>
              <Table.Th w={48} aria-label="Actions" />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {channels.map((channel) => (
              <Table.Tr key={channel.id}>
                <Table.Td>
                  <Text size="sm" fw={600} truncate>
                    {channel.name}
                  </Text>
                  {channel.description ? (
                    <Text size="xs" c="dimmed" truncate>
                      {channel.description}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    {channel.kinds.map((entry) => (
                      <Badge
                        key={entry.kind}
                        variant="light"
                        color="gray"
                        radius="sm"
                        title={entry.kind}
                      >
                        {entry.name}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={
                      toggle.isPending && toggle.variables?.id === channel.id
                        ? toggle.variables.enabled
                        : channel.enabled
                    }
                    onChange={(event) =>
                      toggle.mutate({
                        id: channel.id,
                        enabled: event.currentTarget.checked,
                      })
                    }
                    aria-label={`Enable ${channel.name}`}
                  />
                </Table.Td>
                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Actions for ${channel.name}`}
                      >
                        <IconDotsVertical size={16} stroke={1.6} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconCode size={14} stroke={1.6} />}
                        onClick={() =>
                          setInstructions({ channel, token: null })
                        }
                      >
                        How to push
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconPencil size={14} stroke={1.6} />}
                        onClick={() => setModal({ editing: channel })}
                      >
                        Edit
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconKey size={14} stroke={1.6} />}
                        onClick={() => confirmRotate(channel)}
                      >
                        Rotate token
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} stroke={1.6} />}
                        onClick={() => confirmDelete(channel)}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {modal ? (
        <ChannelModal
          key={modal.editing?.id ?? 'new'}
          editing={modal.editing}
          onClose={() => setModal(null)}
        />
      ) : null}
      <InstructionsModal
        state={instructions}
        onClose={() => setInstructions(null)}
      />
    </Stack>
  );
}
