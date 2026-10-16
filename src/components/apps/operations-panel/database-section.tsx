import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconDatabase, IconTrash } from '@tabler/icons-react';
import { DeleteDatabaseForm } from './delete-database-form';
import { SectionHeader, StatusDot } from './section-header';

export type DatabaseOperationState = {
  enabled: boolean;
  dbName: string | null;
};

export function DatabaseSection({
  appId,
  appName,
  database,
  onDelete,
}: {
  appId: string;
  appName: string;
  database: DatabaseOperationState;
  onDelete: (dbName: string, appName: string) => Promise<void>;
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
          appName={appName}
          managed={false}
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
