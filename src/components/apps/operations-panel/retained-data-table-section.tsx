import {
  ActionIcon,
  Box,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation } from '@tanstack/react-query';
import { IconTable, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { SectionHeader, StatusDot } from './section-header';

function DeleteDataTableForm({
  dbName,
  modalId,
  onDelete,
}: {
  dbName: string;
  modalId: string;
  onDelete: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const remove = useMutation({
    mutationFn: onDelete,
    onSuccess: () => modals.close(modalId),
  });
  const confirmed = confirmation === dbName;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed && !remove.isPending) remove.mutate();
      }}
    >
      <Stack gap="sm">
        <Text size="sm">
          This permanently deletes{' '}
          <Text span fw={600} ff="monospace">
            {dbName}
          </Text>
          , including every managed table, row, and migration record. This
          cannot be undone.
        </Text>
        <Text size="sm" c="dimmed">
          To use Data Tables again, deploy a new release with the capability
          enabled. The platform will create an empty database and apply its
          schema.
        </Text>
        <TextInput
          label={`Type ${dbName} to confirm`}
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          ff="monospace"
          autoComplete="off"
          data-autofocus
        />
        {remove.isError ? (
          <Text size="sm" c="red" role="alert">
            {remove.error instanceof Error
              ? remove.error.message
              : 'Failed to delete the Data Table database.'}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button
            type="button"
            variant="default"
            disabled={remove.isPending}
            onClick={() => modals.close(modalId)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            color="red"
            loading={remove.isPending}
            disabled={!confirmed}
          >
            Delete Data Table data
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function RetainedDataTableSection({
  appId,
  dbName,
  schemaHash,
  onDelete,
}: {
  appId: string;
  dbName: string;
  schemaHash: string | null;
  onDelete: (dbName: string) => Promise<void>;
}) {
  const confirmDelete = () => {
    const modalId = `delete-app-data-database-${appId}`;
    modals.open({
      modalId,
      title: 'Delete retained Data Table data?',
      centered: true,
      children: (
        <DeleteDataTableForm
          dbName={dbName}
          modalId={modalId}
          onDelete={() => onDelete(dbName)}
        />
      ),
    });
  };

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" align="center">
        <Box style={{ minWidth: 0 }}>
          <SectionHeader
            icon={<IconTable size={16} stroke={1.8} />}
            title="Data Tables"
            meta={
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <StatusDot active={false} />
                <Text size="xs" c="dimmed">
                  Disabled
                </Text>
                <Text size="xs" c="dimmed">
                  ·
                </Text>
                <Text size="xs" c="dimmed" ff="monospace" truncate>
                  {dbName}
                </Text>
              </Group>
            }
          />
        </Box>
        <Tooltip
          label="Delete retained Data Table data"
          withArrow
          position="top"
        >
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label={`Delete Data Table database ${dbName}`}
            onClick={confirmDelete}
          >
            <IconTrash size={15} stroke={1.8} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">
        The capability is disabled. This managed database is retained, but App,
        Agent, and Realtime access is unavailable.
      </Text>
      {schemaHash ? (
        <Text size="xs" c="dimmed">
          Latest schema:{' '}
          <Text span ff="monospace" title={schemaHash}>
            {schemaHash.slice(0, 10)}
          </Text>
        </Text>
      ) : null}
    </Stack>
  );
}
