import { ActionIcon, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconDatabaseCog, IconDownload, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { formatBytes, formatRelative } from '~lib/format';
import { appOpsQueryOptions } from '~queries/apps';
import type { AppOps } from '~server/apps';
import { deleteStorageObjectFn } from '~server/apps';
import { SectionHeader } from './section-header';

/** Stored objects with download/delete controls. */
export function StorageSection({
  appId,
  storage,
}: {
  appId: string;
  storage: AppOps['storage'];
}) {
  const qc = useQueryClient();

  const deleteObject = useMutation({
    mutationFn: (key: string) =>
      deleteStorageObjectFn({ data: { id: appId, key } }),
    onSuccess: () => {
      toast.success('Deleted object');
      void qc.invalidateQueries(appOpsQueryOptions(appId));
    },
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

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconDatabaseCog size={16} stroke={1.8} />}
        title="Storage"
        meta={
          <Text size="xs" c="dimmed">
            {storage.objects.length} object
            {storage.objects.length === 1 ? '' : 's'}
          </Text>
        }
      />
      {storage.objects.length === 0 ? (
        <Text size="xs" c="dimmed">
          No objects stored yet.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {storage.objects.map((obj) => (
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
                    {formatRelative(obj.updatedAt)}
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
  );
}
