import { Box, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDatabase, IconServerBolt } from '@tabler/icons-react';
import { appOpsQueryOptions } from '~queries/apps';
import type { AppOps } from '~server/apps';
import { CronSection } from './cron-section';
import { KvSection } from './kv-section';
import { SectionHeader, StatusDot } from './section-header';
import { StorageSection } from './storage-section';
import { WebhookSection } from './webhook-section';

function BackendSection({ backend }: { backend: AppOps['backend'] }) {
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconServerBolt size={16} stroke={1.8} />}
        title="Backend"
        meta={
          <Group gap={6} wrap="nowrap">
            <StatusDot active={backend.running} />
            <Text size="xs" c="dimmed">
              {backend.running ? 'Running' : 'Idle'} ·{' '}
              {backend.mode ?? 'serverless'}
            </Text>
          </Group>
        }
      />
      <Text size="xs" c="dimmed">
        {backend.mode === 'long-running'
          ? 'Kept warm by the platform and restarted automatically if it exits.'
          : 'Booted on demand for each request, then idles down.'}
      </Text>
    </Stack>
  );
}

function DatabaseSection({ dbName }: { dbName?: string | null }) {
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconDatabase size={16} stroke={1.8} />}
        title="Database"
        meta={
          dbName ? (
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {dbName}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              not provisioned
            </Text>
          )
        }
      />
      <Text size="xs" c="dimmed">
        {dbName
          ? 'A dedicated Postgres database for this app.'
          : 'A Postgres database is provisioned automatically on first use.'}
      </Text>
    </Stack>
  );
}

export function OperationsPanel({
  appId,
  dbName,
  dbEnabled,
}: {
  appId: string;
  /** Provisioned database name, or null when not yet provisioned. */
  dbName?: string | null;
  /** Whether this app declares/uses a database (controls the Database row). */
  dbEnabled?: boolean;
}) {
  const query = useQuery(appOpsQueryOptions(appId));

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          Operations
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  const anyEnabled =
    ops.backend.capable ||
    Boolean(dbEnabled) ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.storage.enabled ||
    ops.kv.enabled;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Operations
      </Text>

      {!anyEnabled ? (
        <Text size="sm" c="dimmed">
          No database, backend, scheduled jobs, webhook, storage, or KV to
          manage for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <BackendSection backend={ops.backend} />
          ) : null}
          {dbEnabled ? <DatabaseSection dbName={dbName} /> : null}
          {ops.cron.enabled ? (
            <CronSection appId={appId} cron={ops.cron} />
          ) : null}
          {ops.webhook.enabled ? (
            <WebhookSection webhook={ops.webhook} />
          ) : null}
          {ops.storage.enabled ? (
            <StorageSection appId={appId} storage={ops.storage} />
          ) : null}
          {ops.kv.enabled ? <KvSection appId={appId} /> : null}
        </Stack>
      )}
    </Box>
  );
}
