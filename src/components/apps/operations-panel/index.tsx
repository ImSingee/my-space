import { Box, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFolder, IconServerBolt } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BackendControls,
  BackendStatus,
  BackendTime,
  backendLastExitLabel,
} from '~components/apps/backend-controls';
import {
  appBackendsQueryOptions,
  appOpsQueryOptions,
  deploymentsQueryOptions,
} from '~queries/apps';
import { deleteAppDatabaseFn, type AppOps } from '~server/apps';
import { CronSection } from './cron-section';
import { DataTableSection } from './data-table-section';
import { DatabaseSection } from './database-section';
import { KvSection } from './kv-section';
import { SectionHeader } from './section-header';
import { WebhookSection } from './webhook-section';

/** One runtime metadata row, matching the Overview `Field` layout. */
function RuntimeFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Group gap="md" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        {label}
      </Text>
      {children}
    </Group>
  );
}

function BackendSection({
  appId,
  backend,
}: {
  appId: string;
  backend: AppOps['backend'];
}) {
  // The runtime state lives in the polled Backends list (the same query the
  // Backends page uses), so this section stays live and shares its cache.
  const { data: backends } = useQuery(appBackendsQueryOptions);
  const entry = backends?.find((b) => b.id === appId);
  const runtime = entry?.runtime ?? null;
  const mode = entry?.mode ?? backend.mode ?? 'serverless';

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconServerBolt size={16} stroke={1.8} />}
        title="Backend"
        meta={
          runtime ? (
            <Group gap={10} wrap="nowrap">
              <Group gap={6} wrap="nowrap">
                <BackendStatus runtime={runtime} size="xs" dimmed />
                <Text size="xs" c="dimmed">
                  · {mode}
                </Text>
              </Group>
              <BackendControls appId={appId} runtime={runtime} size="sm" />
            </Group>
          ) : backends ? (
            <Text size="xs" c="dimmed">
              not deployed · {mode}
            </Text>
          ) : null
        }
      />
      <Text size="xs" c="dimmed">
        {mode === 'long-running'
          ? 'Kept warm by the platform and restarted automatically if it exits.'
          : 'Started on demand, then reused by later requests in this platform process; not kept warm.'}
      </Text>
      {runtime ? (
        <Stack gap={6} mt={4}>
          <RuntimeFact label="PID / Port">
            {runtime.state === 'running' && runtime.pid != null ? (
              <Text size="sm" ff="monospace">
                {runtime.pid} · :{runtime.port}
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                —
              </Text>
            )}
          </RuntimeFact>
          <RuntimeFact label="Started">
            <BackendTime value={runtime.startedAt} />
          </RuntimeFact>
          <RuntimeFact label="Last stopped">
            <BackendTime value={runtime.stoppedAt} />
          </RuntimeFact>
          <RuntimeFact label="Last exit">
            <Text size="sm" c="dimmed" ff="monospace">
              {backendLastExitLabel(runtime)}
            </Text>
          </RuntimeFact>
        </Stack>
      ) : null}
    </Stack>
  );
}

function PersistentStorageSection() {
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconFolder size={16} stroke={1.8} />}
        title="Persistent storage"
        meta={
          <Text size="xs" c="dimmed">
            enabled
          </Text>
        }
      />
      <Text size="xs" c="dimmed">
        A private backend directory available through STORAGE_DIR. Files survive
        restarts, deployments, and rollbacks, and are deleted with the app.
        Disabling storage keeps the files but revokes access.
      </Text>
    </Stack>
  );
}

export function OperationsPanel({ appId }: { appId: string }) {
  const query = useQuery(appOpsQueryOptions(appId));
  const queryClient = useQueryClient();

  const deleteDatabase = async (dbName: string) => {
    await deleteAppDatabaseFn({ data: { id: appId, dbName } });
    toast.success('Database deleted');
    await Promise.allSettled([
      queryClient.invalidateQueries(appOpsQueryOptions(appId)),
      queryClient.invalidateQueries(deploymentsQueryOptions(appId)),
    ]);
  };

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

  const databaseVisible = ops.database.enabled || Boolean(ops.database.dbName);
  const hasOperations =
    ops.backend.capable ||
    databaseVisible ||
    ops.storage.enabled ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.kv.enabled ||
    ops.dataTable.enabled;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Operations
      </Text>

      {!hasOperations ? (
        <Text size="sm" c="dimmed">
          No database, Data Tables, persistent storage, backend, scheduled jobs,
          webhook, or KV to manage for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <BackendSection appId={appId} backend={ops.backend} />
          ) : null}
          {databaseVisible ? (
            <DatabaseSection
              appId={appId}
              database={ops.database}
              onDelete={deleteDatabase}
            />
          ) : null}
          {ops.storage.enabled ? <PersistentStorageSection /> : null}
          {ops.dataTable.enabled ? <DataTableSection appId={appId} /> : null}
          {ops.cron.enabled ? (
            <CronSection appId={appId} cron={ops.cron} />
          ) : null}
          {ops.webhook.enabled ? (
            <WebhookSection webhook={ops.webhook} />
          ) : null}
          {ops.kv.enabled ? <KvSection appId={appId} /> : null}
        </Stack>
      )}
    </Box>
  );
}
