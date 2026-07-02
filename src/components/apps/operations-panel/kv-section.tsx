import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconKey, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { formatRelative } from '~lib/format';
import { appKvQueryOptions } from '~queries/apps';
import type { AppKvEntryView } from '~server/apps';
import { deleteAppKvFn, setAppKvFn } from '~server/apps';
import { SectionHeader } from './section-header';

// Add/edit form rendered inside a modal. The key is immutable once created (it
// keys the row); a secret entry's value is never shown, so editing it requires
// typing a new value (overwrite-only).
function KvForm({ appId, entry }: { appId: string; entry?: AppKvEntryView }) {
  const qc = useQueryClient();
  const editing = Boolean(entry);
  const [key, setKey] = useState(entry?.key ?? '');
  // A secret entry's value is masked, so start blank and force a fresh value.
  const [value, setValue] = useState(
    entry && !entry.secret ? (entry.value ?? '') : '',
  );
  const [secret, setSecret] = useState(entry?.secret ?? false);

  const save = useMutation({
    mutationFn: () =>
      setAppKvFn({ data: { id: appId, key: key.trim(), value, secret } }),
    onSuccess: () => {
      toast.success(editing ? 'Updated key' : 'Added key');
      void qc.invalidateQueries(appKvQueryOptions(appId));
      modals.closeAll();
    },
  });

  // A new key always needs a value; editing a secret also does (it's hidden, so
  // there's nothing to keep). Editing a visible value can be left as-is.
  const valueRequired = !editing || Boolean(entry?.secret);
  const canSave = key.trim().length > 0 && (!valueRequired || value.length > 0);

  return (
    <Stack gap="sm">
      <TextInput
        label="Key"
        placeholder="api-token"
        value={key}
        onChange={(e) => setKey(e.currentTarget.value)}
        disabled={editing}
        data-autofocus={!editing}
      />
      <Textarea
        label={editing && entry?.secret ? 'New value' : 'Value'}
        placeholder={
          editing && entry?.secret
            ? 'Enter a new value to overwrite (current value is hidden)'
            : 'value'
        }
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={8}
        data-autofocus={editing}
      />
      <Checkbox
        label="Secret — hide the value here (overwrite-only)"
        checked={secret}
        onChange={(e) => setSecret(e.currentTarget.checked)}
      />
      <Group justify="flex-end" gap="sm">
        <Button
          type="button"
          variant="default"
          onClick={() => modals.closeAll()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          loading={save.isPending}
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          {editing ? 'Save' : 'Add'}
        </Button>
      </Group>
    </Stack>
  );
}

// Per-app key/value store: small durable values (tokens, config) kept in the
// platform DB. The backend reads/writes via the signed KV API; this panel is for
// human management. Secret values are masked (overwrite-only).
export function KvSection({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const query = useQuery(appKvQueryOptions(appId));
  const entries = query.data ?? [];

  const remove = useMutation({
    mutationFn: (key: string) => deleteAppKvFn({ data: { id: appId, key } }),
    onSuccess: () => toast.success('Deleted key'),
    onSettled: () => {
      void qc.invalidateQueries(appKvQueryOptions(appId));
    },
  });

  const openEditor = (entry?: AppKvEntryView) =>
    modals.open({
      title: entry ? `Edit "${entry.key}"` : 'Add KV entry',
      children: <KvForm appId={appId} entry={entry} />,
    });

  const confirmDelete = (key: string) =>
    modals.openConfirmModal({
      title: 'Delete key?',
      children: (
        <Text size="sm">
          Permanently delete{' '}
          <Text span fw={600} ff="monospace">
            {key}
          </Text>
          ? This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(key),
    });

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" align="center">
        <SectionHeader
          icon={<IconKey size={16} stroke={1.8} />}
          title="Key-value store"
          meta={
            entries.length > 0 ? (
              <Text size="xs" c="dimmed">
                {entries.length}
              </Text>
            ) : null
          }
        />
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => openEditor()}
        >
          Add key
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Small per-app values (tokens, config). Your backend reads/writes them
        via the signed KV API; values marked secret are hidden here
        (overwrite-only).
      </Text>
      {query.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : entries.length === 0 ? (
        <Text size="xs" c="dimmed">
          No keys yet.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Key</Table.Th>
              <Table.Th>Value</Table.Th>
              <Table.Th w={110}>Updated</Table.Th>
              <Table.Th w={76} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((entry) => (
              <Table.Tr key={entry.key}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" ff="monospace" lineClamp={1}>
                      {entry.key}
                    </Text>
                    {entry.secret ? (
                      <Badge size="xs" variant="light" color="orange">
                        secret
                      </Badge>
                    ) : null}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {entry.secret ? (
                    <Text size="sm" c="dimmed">
                      ••••••••
                    </Text>
                  ) : (
                    <Text size="sm" ff="monospace" lineClamp={1}>
                      {entry.value}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" truncate>
                    {formatRelative(entry.updatedAt)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Edit" withArrow position="top">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Edit ${entry.key}`}
                        onClick={() => openEditor(entry)}
                      >
                        <IconPencil size={15} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete" withArrow position="top">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Delete ${entry.key}`}
                        loading={
                          remove.isPending && remove.variables === entry.key
                        }
                        onClick={() => confirmDelete(entry.key)}
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
  );
}
