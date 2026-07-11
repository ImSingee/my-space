import { Alert, Button, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import classes from './chat.module.css';

const FALLBACK_ERROR = 'The model provider returned an unknown error.';

export function AgentErrorNotice({
  message,
  live = false,
  onRetry,
  retrying = false,
}: {
  message?: string;
  /** Announce a newly arrived live error; persisted history stays quiet. */
  live?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
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
        {onRetry ? (
          <Button
            type="button"
            size="compact-sm"
            variant="default"
            leftSection={<IconRefresh size={14} stroke={1.8} aria-hidden />}
            onClick={onRetry}
            loading={retrying}
            disabled={retrying}
            aria-busy={retrying}
          >
            Retry
          </Button>
        ) : null}
      </Stack>
    </Alert>
  );
}
