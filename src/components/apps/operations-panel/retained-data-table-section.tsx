import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconTable, IconTrash } from '@tabler/icons-react';
import { DeleteDatabaseForm } from './delete-database-form';
import { SectionHeader, StatusDot } from './section-header';

export function RetainedDataTableSection({
  appId,
  appName,
  dbName,
  schemaHash,
  onDelete,
}: {
  appId: string;
  appName: string;
  dbName: string;
  schemaHash: string | null;
  onDelete: (dbName: string, appName: string) => Promise<void>;
}) {
  const confirmDelete = () => {
    const modalId = `delete-app-data-database-${appId}`;
    modals.open({
      modalId,
      title: 'Delete retained Data Table data?',
      centered: true,
      children: (
        <DeleteDatabaseForm
          appName={appName}
          managed
          modalId={modalId}
          onDelete={(confirmation) => onDelete(dbName, confirmation)}
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
