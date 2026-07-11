import { Alert, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import classes from './chat.module.css';

const FALLBACK_ERROR = 'The model provider returned an unknown error.';

export function AgentErrorNotice({
  message,
  live = false,
}: {
  message?: string;
  /** Announce a newly arrived live error; persisted history stays quiet. */
  live?: boolean;
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
      <Text component="div" size="sm" className={classes.agentErrorDetail}>
        {message?.trim() || FALLBACK_ERROR}
      </Text>
    </Alert>
  );
}
