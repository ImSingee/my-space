import { Button, Group, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconClockX,
  IconCloudX,
  IconDevices,
  IconHistory,
  IconHourglassHigh,
  IconLogin2,
  IconPlugConnectedX,
  IconShieldX,
  IconWorldX,
  type Icon,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { formatUserCode, type DeviceOutcome } from './device-api';
import { ViewHeader } from './layout';
import type { Problem } from './problems';
import classes from './device-approval.module.css';

type Action = 'new-code' | 'sign-in' | 'recheck' | 'deny' | 'home';

type StatusCopy = {
  icon: Icon;
  color: string;
  title: string;
  body: string;
  actions: Action[];
};

const PROBLEMS: Record<Problem, StatusCopy> = {
  expired: {
    icon: IconClockX,
    color: 'gray',
    title: 'This request has expired',
    body: 'Start a new sign-in on your device, then enter the new code.',
    actions: ['new-code'],
  },
  closed: {
    icon: IconHistory,
    color: 'gray',
    title: 'This request is already closed',
    body: 'It was approved, denied or cancelled earlier. Your device shows the result.',
    actions: ['new-code'],
  },
  elsewhere: {
    icon: IconDevices,
    color: 'yellow',
    title: 'Open in another session',
    body: 'Another browser session or account is reviewing this request. Finish there, or start a new sign-in on your device.',
    actions: ['new-code'],
  },
  'signed-out': {
    icon: IconLogin2,
    color: 'gray',
    title: 'Sign in to continue',
    body: 'Your session has ended. You’ll come back to this code after signing in.',
    actions: ['sign-in'],
  },
  'session-ended': {
    icon: IconLogin2,
    color: 'gray',
    title: 'Your session ended',
    body: 'Nothing was approved. Sign in again, then start a new sign-in on your device.',
    actions: ['sign-in'],
  },
  invalidated: {
    icon: IconShieldX,
    color: 'red',
    title: 'Your sign-in details changed',
    body: 'Nothing was approved. Start a new sign-in on your device.',
    actions: ['new-code'],
  },
  disabled: {
    icon: IconPlugConnectedX,
    color: 'gray',
    // Non-breaking hyphen: never split "sign-in" across title lines.
    title: 'Device sign\u2011in is turned off',
    body: 'Nothing was approved. Ask whoever runs this Hatch to turn it on.',
    actions: ['home'],
  },
  origin: {
    icon: IconWorldX,
    color: 'red',
    title: 'Wrong address',
    body: 'Nothing was approved. Open the link exactly as your device printed it.',
    actions: ['home'],
  },
  unapprovable: {
    icon: IconAlertTriangle,
    color: 'yellow',
    title: 'This request can’t be approved',
    body: 'An app or workflow it asks for no longer exists. Deny it, then start a new sign-in on your device.',
    actions: ['deny', 'new-code'],
  },
  'rate-limited': {
    icon: IconHourglassHigh,
    color: 'yellow',
    title: 'Too many attempts',
    body: 'Nothing was recorded. Wait a minute, then try again.',
    actions: ['recheck'],
  },
  unconfirmed: {
    icon: IconCloudX,
    color: 'yellow',
    title: 'Couldn’t confirm your choice',
    body: 'It may or may not have been saved. Your device shows the real result.',
    actions: ['recheck', 'new-code'],
  },
};

const OUTCOMES: Record<DeviceOutcome, StatusCopy> = {
  approved: {
    icon: IconCircleCheck,
    color: 'green',
    title: 'Device approved',
    body: 'Return to your device to finish. You can close this tab.',
    actions: [],
  },
  denied: {
    icon: IconBan,
    color: 'gray',
    title: 'Request denied',
    body: 'Your device won’t get access. You can close this tab.',
    actions: [],
  },
};

const ACTION_LABEL: Record<Action, string> = {
  'new-code': 'Enter a new code',
  'sign-in': 'Sign in again',
  recheck: 'Check again',
  deny: 'Deny request',
  home: 'Go to Hatch',
};

type Handlers = {
  onNewCode: () => void;
  onSignIn: () => void;
  onRecheck: () => void;
  onDeny: () => void;
  /** The action currently in flight, shown as loading. */
  pending: 'recheck' | 'deny' | null;
};

export function ProblemView({
  problem,
  userCode,
  handlers,
}: {
  problem: Problem;
  userCode: string;
  handlers: Handlers;
}) {
  const copy = PROBLEMS[problem];
  return (
    <StatusLayout copy={copy} userCode={userCode}>
      <Group justify="center" gap="sm">
        {copy.actions.map((action, index) => (
          <ActionButton
            key={action}
            action={action}
            primary={index === 0}
            handlers={handlers}
          />
        ))}
      </Group>
    </StatusLayout>
  );
}

export function OutcomeView({
  outcome,
  userCode,
}: {
  outcome: DeviceOutcome;
  userCode: string;
}) {
  return <StatusLayout copy={OUTCOMES[outcome]} userCode={userCode} />;
}

function StatusLayout({
  copy,
  userCode,
  children,
}: {
  copy: StatusCopy;
  userCode: string;
  children?: ReactNode;
}) {
  return (
    <div className={classes.status}>
      <ThemeIcon
        size={52}
        radius="xl"
        variant="light"
        color={copy.color}
        aria-hidden
      >
        <copy.icon size={26} stroke={1.6} />
      </ThemeIcon>
      <ViewHeader title={copy.title} focus>
        {copy.body}
      </ViewHeader>
      {userCode ? (
        <Text size="sm" c="dimmed">
          Code{' '}
          <span className={classes.inlineCode}>{formatUserCode(userCode)}</span>
        </Text>
      ) : null}
      {children}
    </div>
  );
}

function ActionButton({
  action,
  primary,
  handlers,
}: {
  action: Action;
  primary: boolean;
  handlers: Handlers;
}) {
  const variant = primary ? 'filled' : 'default';
  if (action === 'home')
    return (
      <Button component="a" href="/dashboard" variant={variant}>
        {ACTION_LABEL.home}
      </Button>
    );
  const onClick = {
    'new-code': handlers.onNewCode,
    'sign-in': handlers.onSignIn,
    recheck: handlers.onRecheck,
    deny: handlers.onDeny,
  }[action];
  const loading = handlers.pending === action;
  return (
    <Button
      type="button"
      variant={variant}
      loading={loading}
      disabled={handlers.pending !== null && !loading}
      onClick={onClick}
    >
      {ACTION_LABEL[action]}
    </Button>
  );
}
