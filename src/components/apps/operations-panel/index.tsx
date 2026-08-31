import { Box, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDatabase, IconFolder, IconServerBolt } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import {
  BackendControls,
  BackendStatus,
  BackendTime,
  backendLastExitLabel,
} from '~components/apps/backend-controls';
import { NetworkAccessDetails } from '~components/system/network-access';
import { appBackendsQueryOptions, appOpsQueryOptions } from '~queries/apps';
import type { AppOps } from '~server/apps';
import { CronSection } from './cron-section';
import { DataTableSection } from './data-table-section';
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
  runtimeSupported,
}: {
  appId: string;
  backend: AppOps['backend'];
  runtimeSupported: boolean;
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
              <BackendControls
                appId={appId}
                runtime={runtime}
                size="sm"
                runtimeSupported={runtimeSupported}
              />
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
      <RuntimeFact label="Network">
        <NetworkAccessDetails access={backend.network} appPlatformChannels />
      </RuntimeFact>
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

export function OperationsPanel({
  appId,
  dbName,
  dbEnabled,
  runtimeSupported = true,
}: {
  appId: string;
  /** Provisioned database name, or null when not yet provisioned. */
  dbName?: string | null;
  /** Whether this app declares/uses a database (controls the Database row). */
  dbEnabled?: boolean;
  /** Whether controls that invoke App code may run. */
  runtimeSupported?: boolean;
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

      {!anyEnabled ? (
        <Text size="sm" c="dimmed">
          No database, Data Tables, persistent storage, backend, scheduled jobs,
          webhook, or KV to manage for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <BackendSection
              appId={appId}
              backend={ops.backend}
              runtimeSupported={runtimeSupported}
            />
          ) : null}
          {dbEnabled ? <DatabaseSection dbName={dbName} /> : null}
          {ops.storage.enabled ? <PersistentStorageSection /> : null}
          {ops.dataTable.enabled ? <DataTableSection appId={appId} /> : null}
          {ops.cron.enabled ? (
            <CronSection
              appId={appId}
              cron={ops.cron}
              runtimeSupported={runtimeSupported}
            />
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
