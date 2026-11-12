import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';
import { useState } from 'react';
import classes from './chat.module.css';

const FALLBACK_ERROR = 'The model provider returned an unknown error.';

/** The failed turn's automatic retry, on this browser's clock. */
export type AutoRetryStatus = {
  /** Consecutive failures so far; the scheduled retry is this attempt. */
  attempt: number;
  maxAttempts: number;
  /** Epoch ms of the scheduled retry; null once stopped or exhausted. */
  nextRetryAt: number | null;
};

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function AutoRetryLine({
  status,
  scheduledAt,
}: {
  status: AutoRetryStatus;
  scheduledAt: number | null;
}) {
  const [now, setNow] = useState(Date.now);
  useInterval(() => setNow(Date.now()), 1000, {
    autoInvoke: scheduledAt !== null,
  });

  let text: string;
  if (scheduledAt !== null) {
    const remaining = scheduledAt - now;
    const progress = `attempt ${status.attempt} of ${status.maxAttempts}`;
    text =
      remaining > 0
        ? `Retrying automatically in ${formatRemaining(remaining)} · ${progress}`
        : `Retrying now · ${progress}`;
  } else if (status.attempt > status.maxAttempts) {
    text = `Stopped after ${status.maxAttempts} automatic retries.`;
  } else {
    text = 'Automatic retry stopped.';
  }
  return (
    <Text size="xs" c="dimmed" data-testid="agent-auto-retry-status">
      {text}
    </Text>
  );
}

/** Retry actions for the failed turn the notice belongs to. */
export type RetryControls = {
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  autoRetry?: AutoRetryStatus;
  onStopAutoRetry?: () => void;
  stoppingAutoRetry?: boolean;
};

export function AgentErrorNotice({
  message,
  live = false,
  onRetry,
  retrying = false,
  retryDisabled = false,
  autoRetry,
  onStopAutoRetry,
  stoppingAutoRetry = false,
}: RetryControls & {
  message?: string;
  /** Announce a newly arrived live error; persisted history stays quiet. */
  live?: boolean;
}) {
  const scheduledAt =
    autoRetry && autoRetry.attempt > 0 ? autoRetry.nextRetryAt : null;
  return (
    <Alert
      className={classes.agentErrorNotice}
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={18} stroke={1.7} aria-hidden />}
      title="The Agent couldn't complete this reply"
      role={live ? 'alert' : 'note'}
    >
      <Stack gap="xs" align="flex-start" className={classes.agentErrorBody}>
        <Text component="div" size="sm" className={classes.agentErrorDetail}>
          {message?.trim() || FALLBACK_ERROR}
        </Text>
        {autoRetry && autoRetry.attempt > 0 ? (
          // Remount per schedule: the ticking interval starts on mount.
          <AutoRetryLine
            key={scheduledAt ?? 'idle'}
            status={autoRetry}
            scheduledAt={scheduledAt}
          />
        ) : null}
        {onRetry ? (
          <Group gap="xs">
            <Button
              type="button"
              size="compact-sm"
              variant="default"
              leftSection={<IconRefresh size={14} stroke={1.8} aria-hidden />}
              onClick={onRetry}
              loading={retrying}
              disabled={retrying || retryDisabled}
              aria-busy={retrying || undefined}
            >
              {scheduledAt !== null ? 'Retry now' : 'Retry'}
            </Button>
            {scheduledAt !== null && onStopAutoRetry ? (
              <Button
                type="button"
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={
                  <IconPlayerStop size={14} stroke={1.8} aria-hidden />
                }
                onClick={onStopAutoRetry}
                loading={stoppingAutoRetry}
                disabled={stoppingAutoRetry || retrying}
              >
                Stop retrying
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Alert>
  );
}
