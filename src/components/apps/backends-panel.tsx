import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconServerBolt,
  IconSettings,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { StatusDot } from '~components/apps/operations-panel/section-header';
import { formatExact, formatRelative } from '~lib/format';
import { appBackendsQueryOptions } from '~queries/apps';
import {
  restartAppBackendFn,
  startAppBackendFn,
  stopAppBackendFn,
  type AppBackendView,
} from '~server/apps';

function statusLabel(runtime: AppBackendView['runtime']): string {
  if (runtime.state === 'running') return 'Running';
  if (runtime.state === 'starting') return 'Starting';
  // Stopped but still marked keep-alive: it crashed and the platform has an
  // automatic restart pending (backoff timer).
  if (runtime.keepAlive) return 'Restarting';
  return 'Stopped';
}

function lastExitLabel(runtime: AppBackendView['runtime']): string {
  if (runtime.lastExitSignal) return runtime.lastExitSignal;
  if (runtime.lastExitCode != null) return `code ${runtime.lastExitCode}`;
  return '—';
}

function TimeCell({ value }: { value: string | null }) {
  if (!value) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Tooltip label={formatExact(value)} withArrow>
      <Text size="sm" c="dimmed" style={{ cursor: 'default' }}>
        {formatRelative(value)}
      </Text>
    </Tooltip>
  );
}

export function BackendsPanel() {
  const qc = useQueryClient();
  const { data: backends } = useSuspenseQuery(appBackendsQueryOptions);

  // Refresh the list and the app's Operations panel whether the action worked
  // or not — a failure usually means the state changed under us.
  const settled = (id: string) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: appBackendsQueryOptions.queryKey }),
      qc.invalidateQueries({ queryKey: ['apps', id, 'ops'] }),
    ]);

  const start = useMutation({
    mutationFn: (id: string) => startAppBackendFn({ data: id }),
    onSettled: (_data, _error, id) => settled(id),
    onSuccess: () => toast.success('Backend started'),
  });
  const stop = useMutation({
    mutationFn: (id: string) => stopAppBackendFn({ data: id }),
    onSettled: (_data, _error, id) => settled(id),
    onSuccess: () => toast.success('Backend stopped'),
  });
  const restart = useMutation({
    mutationFn: (id: string) => restartAppBackendFn({ data: id }),
    onSettled: (_data, _error, id) => settled(id),
    onSuccess: () => toast.success('Backend restarted'),
  });

  if (backends.length === 0) {
    return (
      <Stack align="center" gap="xs" py={80} px="md">
        <ThemeIcon size={52} radius="xl" variant="light" color="ember">
          <IconServerBolt size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={600} mt="xs">
          No app backends
        </Text>
        <Text size="sm" c="dimmed" ta="center" maw={440}>
          No deployed app declares a backend right now. Deploy an app with the
          backend capability and it will show up here.
        </Text>
        <Button component={Link} to="/apps" mt="md" variant="default">
          Back to Apps
        </Button>
      </Stack>
    );
  }

  return (
    <Table verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>App</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Mode</Table.Th>
          <Table.Th>PID / Port</Table.Th>
          <Table.Th>Started</Table.Th>
          <Table.Th>Last stopped</Table.Th>
          <Table.Th>Last exit</Table.Th>
          <Table.Th w={150} aria-label="Actions" />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {backends.map((backend) => (
          <BackendRow
            key={backend.id}
            backend={backend}
            starting={start.isPending && start.variables === backend.id}
            stopping={stop.isPending && stop.variables === backend.id}
            restarting={restart.isPending && restart.variables === backend.id}
            onStart={() => start.mutate(backend.id)}
            onStop={() => stop.mutate(backend.id)}
            onRestart={() => restart.mutate(backend.id)}
          />
        ))}
      </Table.Tbody>
    </Table>
  );
}

function BackendRow({
  backend,
  starting,
  stopping,
  restarting,
  onStart,
  onStop,
  onRestart,
}: {
  backend: AppBackendView;
  starting: boolean;
  stopping: boolean;
  restarting: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const { runtime } = backend;
  const pending = starting || stopping || restarting;
  const running = runtime.state === 'running';
  // Stop also cancels a boot in progress (starting) and a crashed keep-alive
  // backend's pending auto-restart (stopped but still marked keep-alive).
  const stoppable = runtime.state !== 'stopped' || runtime.keepAlive;

  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <AppGlyph name={backend.name} seed={backend.id} />
          <Stack gap={0} miw={0}>
            <Text
              size="sm"
              fw={600}
              truncate
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: backend.id }}
                  {...props}
                />
              )}
            >
              {backend.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {backend.slug}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <StatusDot active={running} />
          <Text size="sm">{statusLabel(runtime)}</Text>
          {runtime.restartCount > 0 && (
            <Tooltip
              label={`Auto-restarted ${runtime.restartCount} time${runtime.restartCount === 1 ? '' : 's'} since the platform started`}
              withArrow
            >
              <Badge size="xs" variant="light" color="yellow">
                ×{runtime.restartCount}
              </Badge>
            </Tooltip>
          )}
          {runtime.lastError && (
            <Tooltip label={runtime.lastError} withArrow multiline maw={360}>
              <ThemeIcon size="xs" variant="transparent" color="red">
                <IconAlertTriangle size={14} stroke={1.8} />
              </ThemeIcon>
            </Tooltip>
          )}
        </Group>
      </Table.Td>
      <Table.Td>
        <Badge
          size="sm"
          variant="light"
          color={backend.mode === 'long-running' ? 'ember' : 'gray'}
        >
          {backend.mode}
        </Badge>
      </Table.Td>
      <Table.Td>
        {running && runtime.pid != null ? (
          <Text size="sm" ff="monospace">
            {runtime.pid} · :{runtime.port}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <TimeCell value={runtime.startedAt} />
      </Table.Td>
      <Table.Td>
        <TimeCell value={runtime.stoppedAt} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed" ff="monospace">
          {lastExitLabel(runtime)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <Tooltip label="Start" withArrow>
            <ActionIcon
              variant="subtle"
              color="teal"
              loading={starting}
              disabled={pending || running || runtime.state === 'starting'}
              onClick={onStart}
              aria-label={`Start ${backend.name}`}
            >
              <IconPlayerPlay size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={
              !running && stoppable ? 'Stop (cancels auto-restart)' : 'Stop'
            }
            withArrow
          >
            <ActionIcon
              variant="subtle"
              color="red"
              loading={stopping}
              disabled={pending || !stoppable}
              onClick={onStop}
              aria-label={`Stop ${backend.name}`}
            >
              <IconPlayerStop size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Restart" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              loading={restarting}
              disabled={pending}
              onClick={onRestart}
              aria-label={`Restart ${backend.name}`}
            >
              <IconRefresh size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Manage app" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: backend.id }}
                  {...props}
                />
              )}
              aria-label={`Manage ${backend.name}`}
            >
              <IconSettings size={16} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
