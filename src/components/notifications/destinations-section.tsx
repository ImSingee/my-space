import {
  ActionIcon,
  Alert,
  Badge,
  Box,
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
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconSend,
  IconTrash,
} from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import {
  apnsStatusQueryOptions,
  notificationDestinationsQueryOptions,
} from '~queries/notifications';
import {
  createWebhookFn,
  deleteDestinationFn,
  rotateWebhookSecretFn,
  sendTestNotificationFn,
  updateDestinationFn,
  type DestinationView,
} from '~server/notifications';
import { SecretReveal } from './secret-reveal';
import { DESTINATION_TYPE_LABEL, DestinationTypeIcon } from './status';
import { SectionTitle } from './section-title';
import { useNotificationMutation } from './use-notification-mutation';

function ApnsStatusLine() {
  const { data } = useSuspenseQuery(apnsStatusQueryOptions);
  if (data.error) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertCircle size={18} stroke={1.6} />}
      >
        iOS push is misconfigured: {data.error}
      </Alert>
    );
  }
  const environments = [
    data.production ? 'production' : null,
    data.sandbox ? 'sandbox' : null,
  ].filter(Boolean);
  return (
    <Text size="sm" c="dimmed">
      iOS push:{' '}
      {environments.length === 0
        ? 'no APNs key is configured yet, so device deliveries will fail.'
        : `${data.source === 'builtin' ? 'built-in shared key' : 'this instance’s own key'} (${environments.join(', ')}).`}{' '}
      Pushes are end-to-end encrypted; Apple only sees a placeholder.
    </Text>
  );
}

function describe(destination: DestinationView): string {
  if (destination.device) {
    return [
      destination.device.userName ?? 'Unknown user',
      destination.device.platform === 'ios'
        ? 'iOS'
        : destination.device.platform,
      destination.device.environment === 'sandbox' ? 'development build' : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (destination.webhook) return destination.webhook.url;
  if (destination.app) {
    return destination.app.accepting
      ? `App · /app/${destination.app.slug ?? destination.app.appId}`
      : 'App no longer accepts notifications';
  }
  return DESTINATION_TYPE_LABEL[destination.type];
}

function WebhookModal({
  opened,
  onClose,
  editing,
}: {
  opened: boolean;
  onClose: () => void;
  editing: DestinationView | null;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [url, setUrl] = useState(editing?.webhook?.url ?? '');
  const [secret, setSecret] = useState<string | null>(null);

  const create = useNotificationMutation(
    (input: { name: string; url: string }) => createWebhookFn({ data: input }),
    {
      success: 'Webhook added',
      onSuccess: (result) => setSecret(result.secret),
    },
  );
  const update = useNotificationMutation(
    (input: { id: string; name: string; url: string }) =>
      updateDestinationFn({ data: input }),
    { success: 'Webhook updated', onSuccess: () => onClose() },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editing) update.mutate({ id: editing.id, name, url });
    else create.mutate({ name, url });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        editing ? 'Edit webhook' : secret ? 'Webhook added' : 'Add webhook'
      }
      centered
      closeOnClickOutside={!secret}
    >
      {secret ? (
        <Stack gap="md">
          <Text size="sm">
            Hatch POSTs a JSON envelope to this URL and signs it with this
            secret: verify <code>x-hatch-signature</code> as HMAC-SHA256 over{' '}
            <code>{'<x-hatch-timestamp>.<body>'}</code>.
          </Text>
          <SecretReveal label="Signing secret" secret={secret} />
          <Group justify="flex-end">
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack gap="md">
            <TextInput
              label="Name"
              placeholder="Home automation"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={80}
              data-autofocus
            />
            <TextInput
              label="URL"
              placeholder="https://example.com/hooks/hatch"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              required
              type="url"
              description="Redirects are not followed. Local network and Tailscale addresses are allowed."
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={create.isPending || update.isPending}
              >
                {editing ? 'Save' : 'Add webhook'}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function RotatedSecretModal({
  secret,
  onClose,
}: {
  secret: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      opened={secret !== null}
      onClose={onClose}
      title="New signing secret"
      centered
      closeOnClickOutside={false}
    >
      {secret ? (
        <Stack gap="md">
          <Text size="sm">
            The previous secret stopped working. Update the receiver before the
            next delivery.
          </Text>
          <SecretReveal label="Signing secret" secret={secret} />
          <Group justify="flex-end">
            <Button onClick={onClose}>Done</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

function RenameDeviceModal({
  device,
  onClose,
}: {
  device: DestinationView;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const rename = useNotificationMutation(
    (input: { id: string; name: string }) =>
      updateDestinationFn({ data: input }),
    { success: 'Device renamed', onSuccess: () => onClose() },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate({ id: device.id, name: name.trim() });
  };
  return (
    <Modal opened onClose={onClose} title="Rename device" centered>
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            description="The app keeps this name when it registers again."
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
            required
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={rename.isPending}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function DestinationsSection() {
  const { data: destinations } = useSuspenseQuery(
    notificationDestinationsQueryOptions,
  );
  const [webhookModal, setWebhookModal] = useState<{
    editing: DestinationView | null;
  } | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DestinationView | null>(null);

  const toggle = useNotificationMutation(
    (input: { id: string; enabled: boolean }) =>
      updateDestinationFn({ data: input }),
  );
  const test = useNotificationMutation(
    (id: string) => sendTestNotificationFn({ data: id }),
    { success: 'Test notification sent — check the history for the result' },
  );
  const rotate = useNotificationMutation(
    (id: string) => rotateWebhookSecretFn({ data: id }),
    { onSuccess: (result) => setRotated(result.secret) },
  );
  const remove = useNotificationMutation(
    (id: string) => deleteDestinationFn({ data: id }),
    { success: 'Destination removed' },
  );

  const confirmRotate = (destination: DestinationView) =>
    modals.openConfirmModal({
      title: `Rotate the secret of ${destination.name}?`,
      centered: true,
      children: (
        <Text size="sm">
          The current secret stops working immediately. Deliveries are signed
          with the new one.
        </Text>
      ),
      labels: { confirm: 'Rotate secret', cancel: 'Cancel' },
      onConfirm: () => rotate.mutate(destination.id),
    });

  const confirmDelete = (destination: DestinationView) =>
    modals.openConfirmModal({
      title: `Remove ${destination.name}?`,
      centered: true,
      children: (
        <Text size="sm">
          {destination.type === 'device'
            ? 'The device stops receiving pushes until it turns push notifications on again.'
            : 'Routes and group memberships that point at this webhook are removed. Delivery history is kept.'}
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(destination.id),
    });

  return (
    <Stack gap="md">
      <SectionTitle
        title="Destinations"
        description="Devices register themselves from the Hatch iOS app. Apps appear when their manifest accepts notifications."
        action={
          <Button
            variant="default"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setWebhookModal({ editing: null })}
          >
            Add webhook
          </Button>
        }
      />
      <ApnsStatusLine />

      {destinations.length === 0 ? (
        <Text size="sm" c="dimmed" py="md">
          No destinations yet. Add a webhook, sign in from the iOS app, or
          deploy an App that accepts notifications.
        </Text>
      ) : (
        <Table verticalSpacing="sm" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Destination</Table.Th>
              <Table.Th w={90}>Enabled</Table.Th>
              <Table.Th w={48} aria-label="Actions" />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {destinations.map((destination) => (
              <Table.Tr key={destination.id}>
                <Table.Td>
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <Box c="dimmed" pt={2} style={{ display: 'inline-flex' }}>
                      <DestinationTypeIcon type={destination.type} />
                    </Box>
                    <Stack gap={0} miw={0}>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={600} truncate>
                          {destination.name}
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                          {DESTINATION_TYPE_LABEL[destination.type]}
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed" truncate>
                        {describe(destination)}
                      </Text>
                      {destination.lastError ? (
                        <Text size="xs" c="red.8">
                          {destination.lastError}
                        </Text>
                      ) : null}
                    </Stack>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={
                      toggle.isPending &&
                      toggle.variables?.id === destination.id
                        ? toggle.variables.enabled
                        : destination.enabled
                    }
                    onChange={(event) =>
                      toggle.mutate({
                        id: destination.id,
                        enabled: event.currentTarget.checked,
                      })
                    }
                    aria-label={`Enable ${destination.name}`}
                  />
                </Table.Td>
                <Table.Td>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Actions for ${destination.name}`}
                      >
                        <IconDotsVertical size={16} stroke={1.6} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconSend size={14} stroke={1.6} />}
                        disabled={!destination.enabled}
                        onClick={() => test.mutate(destination.id)}
                      >
                        Send test
                      </Menu.Item>
                      {destination.type === 'device' ? (
                        <Menu.Item
                          leftSection={<IconPencil size={14} stroke={1.6} />}
                          onClick={() => setRenaming(destination)}
                        >
                          Rename
                        </Menu.Item>
                      ) : null}
                      {destination.type === 'webhook' ? (
                        <>
                          <Menu.Item
                            leftSection={<IconPencil size={14} stroke={1.6} />}
                            onClick={() =>
                              setWebhookModal({ editing: destination })
                            }
                          >
                            Edit
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconKey size={14} stroke={1.6} />}
                            onClick={() => confirmRotate(destination)}
                          >
                            Rotate secret
                          </Menu.Item>
                        </>
                      ) : null}
                      {destination.type !== 'app' ? (
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} stroke={1.6} />}
                          onClick={() => confirmDelete(destination)}
                        >
                          Remove
                        </Menu.Item>
                      ) : null}
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {webhookModal ? (
        <WebhookModal
          key={webhookModal.editing?.id ?? 'new'}
          opened
          editing={webhookModal.editing}
          onClose={() => setWebhookModal(null)}
        />
      ) : null}
      {renaming ? (
        <RenameDeviceModal
          key={renaming.id}
          device={renaming}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      <RotatedSecretModal secret={rotated} onClose={() => setRotated(null)} />
    </Stack>
  );
}
