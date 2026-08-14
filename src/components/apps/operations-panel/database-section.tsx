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
import { IconDatabase, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { SectionHeader, StatusDot } from './section-header';

export type DatabaseOperationState = {
  enabled: boolean;
  dbName: string | null;
};

function DeleteDatabaseForm({
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
          </Text>{' '}
          and all data stored in it. This cannot be undone.
        </Text>
        <Text size="sm" c="dimmed">
          To use a database again, deploy a version with the database capability
          enabled.
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
              : 'Failed to delete the database.'}
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
            Delete database
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function DatabaseSection({
  appId,
  database,
  onDelete,
}: {
  appId: string;
  database: DatabaseOperationState;
  onDelete: (dbName: string) => Promise<void>;
}) {
  const { enabled, dbName } = database;
  if (!enabled && !dbName) return null;

  const confirmDelete = () => {
    if (enabled || !dbName) return;
    const modalId = `delete-app-database-${appId}`;
    modals.open({
      modalId,
      title: 'Delete database?',
      centered: true,
      children: (
        <DeleteDatabaseForm
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
            icon={<IconDatabase size={16} stroke={1.8} />}
            title="Database"
            meta={
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <StatusDot active={enabled} />
                <Text size="xs" c="dimmed">
                  {enabled ? 'Enabled' : 'Disabled'}
                </Text>
                <Text size="xs" c="dimmed">
                  ·
                </Text>
                {dbName ? (
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {dbName}
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed">
                    not provisioned
                  </Text>
                )}
              </Group>
            }
          />
        </Box>
        {!enabled && dbName ? (
          <Tooltip label="Delete database" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label={`Delete database ${dbName}`}
              onClick={confirmDelete}
            >
              <IconTrash size={15} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      <Text size="xs" c="dimmed">
        {enabled
          ? dbName
            ? 'A dedicated Postgres database for this app.'
            : 'A dedicated Postgres database is provisioned during deployment.'
          : 'Database capability is disabled. This retained database is not injected into the app backend.'}
      </Text>
    </Stack>
  );
}
