import {
  ActionIcon,
  Badge,
  Group,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { StatusDot } from '~components/apps/operations-panel/section-header';
import { formatExact, formatRelative } from '~lib/format';
import { appBackendsQueryOptions, appOpsQueryOptions } from '~queries/apps';
import {
  restartAppBackendFn,
  startAppBackendFn,
  stopAppBackendFn,
  type AppBackendRuntime,
} from '~server/apps';

export function backendStatusLabel(runtime: AppBackendRuntime): string {
  if (runtime.state === 'running') return 'Running';
  if (runtime.state === 'starting') return 'Starting';
  // Stopped but still marked keep-alive: it crashed and the platform has an
  // automatic restart pending (backoff timer).
  if (runtime.keepAlive) return 'Restarting';
  return 'Stopped';
}

export function backendLastExitLabel(runtime: AppBackendRuntime): string {
  if (runtime.lastExitSignal) return runtime.lastExitSignal;
  if (runtime.lastExitCode != null) return `code ${runtime.lastExitCode}`;
  return '—';
}

/** Relative timestamp with the exact time in a tooltip, or a dash. */
export function BackendTime({ value }: { value: string | null }) {
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

/**
 * Status dot + label, plus the auto-restart counter and last-error indicator
 * when present. Shared by the Backends table and the app's Operations panel
 * so both surfaces always tell the same story.
 */
export function BackendStatus({
  runtime,
  size = 'sm',
  dimmed = false,
}: {
  runtime: AppBackendRuntime;
  size?: 'xs' | 'sm';
  dimmed?: boolean;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      <StatusDot active={runtime.state === 'running'} />
      <Text size={size} c={dimmed ? 'dimmed' : undefined}>
        {backendStatusLabel(runtime)}
      </Text>
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
  );
}

/**
 * Start / Stop / Restart controls for one app backend. Owns the mutations and
 * refreshes both the Backends list and the app's Operations panel whether the
 * action worked or not — a failure usually means the state changed under us.
 */
export function BackendControls({
  appId,
  runtime,
  name = 'backend',
  size = 'md',
}: {
  appId: string;
  runtime: AppBackendRuntime;
  /** Accessible target name for the action labels; defaults to "backend". */
  name?: string;
  /** Icon button size; "sm" fits inline in a section header. */
  size?: 'sm' | 'md';
}) {
  const iconSize = size === 'sm' ? 14 : 16;
  const qc = useQueryClient();
  const settled = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: appBackendsQueryOptions.queryKey }),
      qc.invalidateQueries({ queryKey: appOpsQueryOptions(appId).queryKey }),
    ]);

  const start = useMutation({
    mutationFn: () => startAppBackendFn({ data: appId }),
    onSettled: settled,
    onSuccess: () => toast.success('Backend started'),
  });
  const stop = useMutation({
    mutationFn: () => stopAppBackendFn({ data: appId }),
    onSettled: settled,
    onSuccess: () => toast.success('Backend stopped'),
  });
  const restart = useMutation({
    mutationFn: () => restartAppBackendFn({ data: appId }),
    onSettled: settled,
    onSuccess: () => toast.success('Backend restarted'),
  });

  const pending = start.isPending || stop.isPending || restart.isPending;
  const running = runtime.state === 'running';
  // Stop also cancels a boot in progress (starting) and a crashed keep-alive
  // backend's pending auto-restart (stopped but still marked keep-alive).
  const stoppable = runtime.state !== 'stopped' || runtime.keepAlive;

  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label="Start" withArrow>
        <ActionIcon
          variant="subtle"
          color="teal"
          size={size}
          loading={start.isPending}
          disabled={pending || running || runtime.state === 'starting'}
          onClick={() => start.mutate()}
          aria-label={`Start ${name}`}
        >
          <IconPlayerPlay size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
      <Tooltip
        label={!running && stoppable ? 'Stop (cancels auto-restart)' : 'Stop'}
        withArrow
      >
        <ActionIcon
          variant="subtle"
          color="red"
          size={size}
          loading={stop.isPending}
          disabled={pending || !stoppable}
          onClick={() => stop.mutate()}
          aria-label={`Stop ${name}`}
        >
          <IconPlayerStop size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Restart" withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={size}
          loading={restart.isPending}
          disabled={pending}
          onClick={() => restart.mutate()}
          aria-label={`Restart ${name}`}
        >
          <IconRefresh size={iconSize} stroke={1.8} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
